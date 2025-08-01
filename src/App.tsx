import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { clips, ShaderEffect, shaderEffects } from "./utils";
import { useWebGLRenderer } from "./hooks/useWebGLRenderer";
import {
  createInitialTransitions,
  startTransition,
  updateTransitions,
  hasActiveTransitions,
  type EffectTransitions
} from "./transitions";
import { settingsService } from "./services/settingsService";
import { useMidi, type MidiConfig } from "./hooks/useMidi";
import ControlPanel from "./ControlPanel";
import packageJson from "../package.json";

const VERSION = packageJson.version;

const clipKeyBindings: Record<string, string> = {
  q: clips[0].id,
  w: clips[1].id,
  e: clips[2].id,
  r: clips[3].id,
};

const App = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // BPM tapping state
  const [bpm, setBpm] = useState<number>(120); // Default BPM
  const [isSettingBpm, setIsSettingBpm] = useState<boolean>(false);
  const tapTimesRef = useRef<number[]>([]);

  // BPM calculation helpers
  const calculateBpmFromTaps = useCallback((times: number[]): number => {
    if (times.length < 2) return 120;

    // Calculate intervals between taps
    const intervals = [];
    for (let i = 1; i < times.length; i++) {
      intervals.push(times[i] - times[i - 1]);
    }

    // Average the intervals
    const avgInterval = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;

    // Convert to BPM (60000ms = 1 minute)
    const rawBpm = 60000 / avgInterval;

    // Round to nearest 5 for more musical BPMs
    return Math.max(60, Math.min(200, Math.round(rawBpm / 5) * 5));
  }, []);

  const handleBpmTap = useCallback(() => {
    const now = performance.now();

    // Add current tap and keep only recent taps
    const newTimes = [...tapTimesRef.current, now];
    const cutoffTime = now - 10000;
    const recentTimes = newTimes.filter(time => time > cutoffTime).slice(-8);

    tapTimesRef.current = recentTimes;

    // Calculate BPM if we have at least 2 taps
    if (recentTimes.length >= 2) {
      const newBpm = calculateBpmFromTaps(recentTimes);
      setBpm(newBpm);
      setIsSettingBpm(true);

      // Auto-complete BPM setting after 2 beat intervals of inactivity
      const expectedInterval = 60000 / newBpm;
      const timeoutDuration = expectedInterval * 2 + 500; // 2 beats + 500ms buffer

      setTimeout(() => {
        setIsSettingBpm(false);
        tapTimesRef.current = [];
      }, timeoutDuration);
    }
  }, [calculateBpmFromTaps]);

  // Key binding handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      // Handle spacebar for BPM tapping
      if (event.code === 'Space') {
        event.preventDefault();
        handleBpmTap();
        return;
      }

      // Handle clip key bindings
      const clipId = clipKeyBindings[event.key];
      if (!clipId) return;

      setPlayingClips((prev) => {
        const now = performance.now() / 1000;
        const isNowPlaying = !prev[clipId];
        if (isNowPlaying) {
          setClipStartTimes((times) => ({ ...times, [clipId]: now }));
        }
        return { ...prev, [clipId]: isNowPlaying };
      });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleBpmTap]);

  // State management with default values
  const initialActiveEffects = Object.values(ShaderEffect).reduce(
    (effects, effect) => {
      effects[effect] = false;
      return effects;
    },
    {} as Record<ShaderEffect, boolean>
  );

  const [activeEffects, setActiveEffects] = useState<Record<ShaderEffect, boolean>>(initialActiveEffects);

  const [effectIntensities, setEffectIntensities] = useState<Record<ShaderEffect, number>>(() => {
    const intensities: Record<ShaderEffect, number> = {} as Record<ShaderEffect, number>;
    Object.values(ShaderEffect).forEach((effect) => {
      const effectDef = shaderEffects[effect];
      if (effectDef.intensity !== undefined) {
        intensities[effect] = effectDef.intensity;
      }
    });
    return intensities;
  });

  // Transition state for smooth effect animations
  const [effectTransitions, setEffectTransitions] = useState<EffectTransitions>(createInitialTransitions);

  // Computed rendering state based on transitions
  const renderingEffects = useMemo(() => Object.fromEntries(
    Object.values(ShaderEffect).map(effect => [
      effect,
      effectTransitions[effect].isActive
    ])
  ) as Record<ShaderEffect, boolean>, [effectTransitions]);

  const renderingIntensities = useMemo(() => Object.fromEntries(
    Object.values(ShaderEffect).map(effect => {
      const transition = effectTransitions[effect];
      const effectDef = shaderEffects[effect];

      // For effects with intensity controls, use the actual value (including 0)
      // For effects without intensity controls, default to 1
      const hasIntensityControl = effectDef.intensity !== undefined;
      const userIntensity = hasIntensityControl
        ? (effectIntensities[effect] ?? effectDef.intensity)
        : 1;

      return [effect, transition.currentIntensity * userIntensity];
    })
  ) as Record<ShaderEffect, number>, [effectTransitions, effectIntensities]);

  const [showPanel, setShowPanel] = useState(false);
  const [inputSource, setInputSource] = useState("video"); // Changed default to video with black screen
  const [currentBlobUrl, setCurrentBlobUrl] = useState<string | null>(null);
  
  // Video playlist system
  const [videoPlaylist, setVideoPlaylist] = useState<Array<{
    id: string;
    name: string;
    url?: string;
    file?: File;
    isDefault?: boolean;
  }>>([
    {
      id: 'big-buck-bunny',
      name: 'Big Buck Bunny',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      isDefault: true
    }
  ]);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [videoPausedManually, setVideoPausedManually] = useState(false);
  
  // Video timeline state
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);

  const [playingClips, setPlayingClips] = useState<Record<string, boolean>>(
    () =>
      clips.reduce((acc, clip) => {
        acc[clip.id] = false;
        return acc;
      }, {} as Record<string, boolean>)
  );

  const [loopClips, setLoopClips] = useState<Record<string, boolean>>(() =>
    clips.reduce((acc, clip) => {
      acc[clip.id] = false;
      return acc;
    }, {} as Record<string, boolean>)
  );

  const [clipStartTimes, setClipStartTimes] = useState<Record<string, number>>(
    {}
  );

  const [showHelp, setShowHelp] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [fps, setFps] = useState(0);
  const [frameTime, setFrameTime] = useState(0);
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [showMidiSyncNotification, setShowMidiSyncNotification] = useState(false);

  // Popup window reference
  const popupWindowRef = useRef<Window | null>(null);

  // Performance tracking callback for WebGL renderer
  const handleRenderPerformance = useCallback((renderFps: number, frameTimeMs: number) => {
    setFps(renderFps);
    setFrameTime(frameTimeMs);
  }, []);

  // Load settings from localStorage on mount only
  useEffect(() => {
    const savedSettings = settingsService.loadSettings();

    if (savedSettings.showHelp !== undefined) setShowHelp(savedSettings.showHelp);
    if (savedSettings.isMuted !== undefined) setIsMuted(savedSettings.isMuted);
    if (savedSettings.inputSource !== undefined) setInputSource(savedSettings.inputSource);
    if (savedSettings.activeEffects !== undefined) setActiveEffects(savedSettings.activeEffects);
    // No longer loading effectIntensities from localStorage - they should be controlled by MIDI only
    if (savedSettings.loopClips !== undefined) setLoopClips(savedSettings.loopClips);
    if (savedSettings.bpm !== undefined) setBpm(savedSettings.bpm);
  }, []); // Empty dependency array - only run on mount

  // Save settings when they change (not on initialization)
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    // Skip saving during initial load
    if (!isInitialized) {
      setIsInitialized(true);
      return;
    }
    settingsService.saveShowHelp(showHelp);
  }, [showHelp, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    settingsService.saveMuted(isMuted);
  }, [isMuted, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    settingsService.saveInputSource(inputSource);
  }, [inputSource, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    settingsService.saveActiveEffects(activeEffects);
  }, [activeEffects, isInitialized]);

  // No longer saving effectIntensities to localStorage - they should be controlled by MIDI only

  useEffect(() => {
    if (!isInitialized) return;
    settingsService.saveLoopClips(loopClips);
  }, [loopClips, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    settingsService.saveBpm(bpm);
  }, [bpm, isInitialized]);

  // Apply mute state to video element
  useEffect(() => {
    const videoElement = videoRef.current;
    if (videoElement) {
      videoElement.muted = isMuted;
    }
  }, [isMuted]);

  // Animation loop for smooth transitions
  useEffect(() => {
    let animationFrameId: number;

    function animate() {
      const now = performance.now();

      setEffectTransitions(currentTransitions => {
        const newTransitions = updateTransitions(currentTransitions, now);

        // Continue animation if there are active transitions
        if (hasActiveTransitions(newTransitions)) {
          animationFrameId = requestAnimationFrame(animate);
        }

        return newTransitions;
      });
    }

    // Start animation loop if there are active transitions
    if (hasActiveTransitions(effectTransitions)) {
      animationFrameId = requestAnimationFrame(animate);
    }

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [effectTransitions]); // Re-run when transitions change

  // Input Source Setup
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Clean up previous blob URL if it exists
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      setCurrentBlobUrl(null);
    }

    videoElement.crossOrigin = "anonymous";
    if (videoElement.srcObject) {
      const stream = videoElement.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoElement.srcObject = null;
    }

    if (inputSource === "webcam") {
      videoElement.src = "";
      // Stop any playing video first
      videoElement.pause();
      setIsVideoPlaying(false);
      
      navigator.mediaDevices
        .getUserMedia({ video: true })
        .then((stream) => {
          videoElement.srcObject = stream;
          return videoElement.play();
        })
        .catch(console.error);
    } else if (inputSource === "video") {
      // Only pause if we were previously on webcam or if there's no current video
      const wasOnWebcam = videoElement.srcObject !== null;
      if (wasOnWebcam) {
        videoElement.pause();
        setIsVideoPlaying(false);
      }

      // Load current video from playlist but don't auto-play unless switching from webcam
      const currentVideo = videoPlaylist[currentVideoIndex];
      if (currentVideo) {
        // Only change source if it's different from current
        let newSrc = "";
        if (currentVideo.file) {
          const fileUrl = URL.createObjectURL(currentVideo.file);
          setCurrentBlobUrl(fileUrl);
          newSrc = fileUrl;
        } else if (currentVideo.url) {
          newSrc = currentVideo.url;
        }

        // Only reload if source is actually changing
        if (videoElement.src !== newSrc) {
          videoElement.src = newSrc;
          videoElement.loop = false;
          videoElement.load();
        }
      } else {
        // No videos in playlist - clear source for black screen
        videoElement.src = "";
      }
    }
  }, [inputSource, currentVideoIndex, videoPlaylist]);

  // Cleanup blob URL on component unmount or when currentBlobUrl changes
  useEffect(() => {
    return () => {
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
    };
  }, [currentBlobUrl]);

  // UI Handlers
  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setShowPanel((prev) => !prev);
  };

  const handleClipFinished = useCallback((clipId: string) => {
    setPlayingClips((prev) => ({ ...prev, [clipId]: false }));
  }, []);

  // Multi-pass WebGL renderer (using computed rendering state for smooth transitions)
  useWebGLRenderer({
    canvasRef,
    videoRef,
    activeEffects: renderingEffects,
    effectIntensities: renderingIntensities,
    playingClips,
    loopClips,
    clipStartTimes,
    inputSource,
    bpm,
    onClipFinished: handleClipFinished,
    onRenderPerformance: handleRenderPerformance,
  });



  // Debounce to prevent rapid MIDI triggers
  const lastToggleTime = useRef<Record<string, number>>({});

  const handleCheckboxChange = useCallback((effect: ShaderEffect) => {
    const now = performance.now();

    // Debounce: ignore rapid successive calls for the same effect
    const lastTime = lastToggleTime.current[effect] || 0;
    if (now - lastTime < 50) { // 50ms debounce
      return;
    }
    lastToggleTime.current[effect] = now;

    // Use functional update to get current state - fixes stale closure issue
    setActiveEffects((prev) => {
      const nextEffect = !prev[effect];

      // Start smooth transition with current state
      setEffectTransitions(currentTransitions => {
        const targetIntensity = nextEffect ? 1 : 0;
        const newTransitions = startTransition(currentTransitions, effect, targetIntensity, now);
        return newTransitions;
      });

      return {
        ...prev,
        [effect]: nextEffect,
      };
    });
  }, []); // Empty dependency array - no stale closure!

  const handleIntensityChange = useCallback((effect: ShaderEffect, intensity: number) => {
    setEffectIntensities((prev) => ({
      ...prev,
      [effect]: intensity,
    }));

    // If effect has an active transition, update the target intensity
    setEffectTransitions(currentTransitions => {
      const transition = currentTransitions[effect];
      if (transition.isActive && activeEffects[effect]) {
        return {
          ...currentTransitions,
          [effect]: {
            ...transition,
            targetIntensity: 1, // Always target full intensity for active effects
          }
        };
      }
      return currentTransitions;
    });
  }, [activeEffects]);

  const handlePlayToggle = useCallback((clipId: string) => {
    setPlayingClips((prev) => {
      const now = performance.now() / 1000;
      const isNowPlaying = !prev[clipId];
      if (isNowPlaying) {
        setClipStartTimes((times) => ({ ...times, [clipId]: now }));
      }
      return { ...prev, [clipId]: isNowPlaying };
    });
  }, []);

  const handleLoopToggle = useCallback((clipId: string) => {
    setLoopClips((prev) => ({ ...prev, [clipId]: !prev[clipId] }));
  }, []);

  const handleInputSourceChange = useCallback((newSource: string) => {
    setInputSource(newSource);
  }, []);

  // New playlist management functions
  const handleVideoPlayPause = useCallback(() => {
    const videoElement = videoRef.current;
    if (!videoElement || inputSource !== "video") return;

    if (isVideoPlaying) {
      videoElement.pause();
      setIsVideoPlaying(false);
      setVideoPausedManually(true);
    } else {
      videoElement.play().then(() => {
        setIsVideoPlaying(true);
        setVideoPausedManually(false);
      }).catch((err) => {
        if (err.name !== 'AbortError') {
          console.error("Error playing video:", err);
        }
      });
    }
  }, [isVideoPlaying, inputSource]);

  const handleNextVideo = useCallback(() => {
    if (videoPlaylist.length <= 1) return;
    const nextIndex = (currentVideoIndex + 1) % videoPlaylist.length;
    const wasPlaying = isVideoPlaying;
    setCurrentVideoIndex(nextIndex);
    // Don't reset playback state - keep playing if it was playing
    if (wasPlaying) {
      // Small delay to let video load, then resume playback
      setTimeout(() => {
        const videoElement = videoRef.current;
        if (videoElement) {
          videoElement.play().then(() => {
            setIsVideoPlaying(true);
          }).catch(console.error);
        }
      }, 100);
    }
  }, [currentVideoIndex, videoPlaylist.length, isVideoPlaying]);

  const handlePreviousVideo = useCallback(() => {
    if (videoPlaylist.length <= 1) return;
    const prevIndex = currentVideoIndex === 0 ? videoPlaylist.length - 1 : currentVideoIndex - 1;
    const wasPlaying = isVideoPlaying;
    setCurrentVideoIndex(prevIndex);
    // Don't reset playback state - keep playing if it was playing
    if (wasPlaying) {
      // Small delay to let video load, then resume playback
      setTimeout(() => {
        const videoElement = videoRef.current;
        if (videoElement) {
          videoElement.play().then(() => {
            setIsVideoPlaying(true);
          }).catch(console.error);
        }
      }, 100);
    }
  }, [currentVideoIndex, videoPlaylist.length, isVideoPlaying]);

  const handleAddVideosToPlaylist = useCallback((files: File[]) => {
    const videoFiles = files.filter(file => file.type.startsWith('video/'));
    const newVideos = videoFiles.map(file => ({
      id: `video-${Date.now()}-${Math.random()}`,
      name: file.name,
      file
    }));
    
    setVideoPlaylist(prev => [...prev, ...newVideos]);
    
    // Switch to first added video only if playlist was empty AND nothing is currently playing
    if (videoPlaylist.length === 0 && newVideos.length > 0 && !isVideoPlaying) {
      setCurrentVideoIndex(0);
    }
    
    // Only switch to video input source if we're not already in video mode
    if (newVideos.length > 0 && inputSource !== "video") {
      setInputSource("video");
    }
  }, [videoPlaylist.length, isVideoPlaying, inputSource]);

  const handleRemoveFromPlaylist = useCallback((videoId: string) => {
    setVideoPlaylist(prev => {
      const newPlaylist = prev.filter(video => video.id !== videoId);
      // Adjust current index if needed
      if (currentVideoIndex >= newPlaylist.length) {
        setCurrentVideoIndex(Math.max(0, newPlaylist.length - 1));
      }
      return newPlaylist;
    });
  }, [currentVideoIndex]);

  // Handle video ended event to go to next video
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleVideoEnded = () => {
      if (inputSource === "video" && !videoPausedManually) {
        // Auto-advance to next video
        handleNextVideo();
      }
    };

    const handleTimeUpdate = () => {
      if (!isSeeking) {
        setCurrentTime(videoElement.currentTime);
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(videoElement.duration);
      setCurrentTime(0);
    };

    const handleDurationChange = () => {
      setDuration(videoElement.duration);
    };

    videoElement.addEventListener('ended', handleVideoEnded);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('durationchange', handleDurationChange);

    return () => {
      videoElement.removeEventListener('ended', handleVideoEnded);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('durationchange', handleDurationChange);
    };
  }, [inputSource, videoPausedManually, handleNextVideo, isSeeking]);

  // Timeline seeking handlers
  const handleSeek = useCallback((time: number) => {
    const videoElement = videoRef.current;
    if (videoElement && inputSource === "video") {
      videoElement.currentTime = time;
      setCurrentTime(time);
    }
  }, [inputSource]);

  const handleSeekStart = useCallback(() => {
    setIsSeeking(true);
  }, []);

  const handleSeekEnd = useCallback(() => {
    setIsSeeking(false);
  }, []);

  const handleMuteToggle = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  // MIDI hook configuration
  const midiConfig: MidiConfig = useMemo(() => ({
    onEffectToggle: (effect: ShaderEffect) => {
      handleCheckboxChange(effect);
    },
    onIntensityChange: (effect: ShaderEffect, intensity: number) => {
      setEffectIntensities(prev => ({
        ...prev,
        [effect]: intensity
      }));
    },
    onMidiConnect: () => {
      // Show notification to sync knobs
      setShowMidiSyncNotification(true);
      // Hide notification after 5 seconds
      setTimeout(() => {
        setShowMidiSyncNotification(false);
      }, 5000);
    },
  }), [handleCheckboxChange]);

  const midi = useMidi(midiConfig);

  // Popup window handlers
  const openPopupWindow = useCallback(() => {
    if (popupWindowRef.current && !popupWindowRef.current.closed) {
      popupWindowRef.current.focus();
      return;
    }

    const popup = window.open(
      '',
      'controlPanel',
      'width=450,height=700,resizable=yes,scrollbars=yes,toolbar=no,menubar=no,location=no,status=no,left=100,top=100'
    );

    if (popup) {
      popupWindowRef.current = popup;
      setIsPopupOpen(true);

      // Setup popup window
      popup.document.title = 'Trippy Vids Controls';

      // Copy all CSS from parent window to popup
      const styles = Array.from(document.styleSheets);
      styles.forEach((styleSheet) => {
        try {
          if (styleSheet.href) {
            // External stylesheet
            const link = popup.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = styleSheet.href;
            popup.document.head.appendChild(link);
          } else if (styleSheet.cssRules) {
            // Inline styles
            const style = popup.document.createElement('style');
            const cssText = Array.from(styleSheet.cssRules).map(rule => rule.cssText).join('\n');
            style.textContent = cssText;
            popup.document.head.appendChild(style);
          }
        } catch {
          // Some stylesheets might not be accessible due to CORS - ignore silently
        }
      });

      // Create container for React content
      const container = popup.document.createElement('div');
      container.id = 'popup-root';
      popup.document.body.appendChild(container);

      // Handle popup close
      popup.addEventListener('beforeunload', () => {
        setIsPopupOpen(false);
        popupWindowRef.current = null;
      });
    }
  }, []);

  // Clean up popup on unmount
  useEffect(() => {
    return () => {
      if (popupWindowRef.current && !popupWindowRef.current.closed) {
        popupWindowRef.current.close();
      }
    };
  }, []);

  // Render control panel in popup window
  const popupControlPanel = useMemo(() => {
    if (!isPopupOpen || !popupWindowRef.current || popupWindowRef.current.closed) {
      return null;
    }

    const popupContainer = popupWindowRef.current.document.getElementById('popup-root');
    if (!popupContainer) return null;

    return createPortal(
      <ControlPanel
        activeEffects={activeEffects}
        bpm={bpm}
        effectIntensities={effectIntensities}
        inputSource={inputSource}
        isSettingBpm={isSettingBpm}
        loopClips={loopClips}
        isMuted={isMuted}
        midiConnected={midi.connected}
        midiDeviceName={midi.deviceName}
        isPopupMode={true}
        onInputSourceChange={handleInputSourceChange}
        onFileSelected={() => {}} // This function is no longer used
        onIntensityChange={handleIntensityChange}
        onLoopToggle={handleLoopToggle}
        onMuteToggle={handleMuteToggle}
        onPlayToggle={handlePlayToggle}
        onToggleEffect={handleCheckboxChange}
        onToggleHelp={() => setShowHelp(!showHelp)}
        playingClips={playingClips}
        showHelp={showHelp}
        videoPlaylist={videoPlaylist}
        currentVideoIndex={currentVideoIndex}
        isVideoPlaying={isVideoPlaying}
        onVideoPlayPause={handleVideoPlayPause}
        onNextVideo={handleNextVideo}
        onPreviousVideo={handlePreviousVideo}
        onAddVideosToPlaylist={handleAddVideosToPlaylist}
        onRemoveFromPlaylist={handleRemoveFromPlaylist}
        onSeek={handleSeek}
        onSeekStart={handleSeekStart}
        onSeekEnd={handleSeekEnd}
        currentTime={currentTime}
        duration={duration}
        isSeeking={isSeeking}
      />,
      popupContainer
    );
  }, [
    isPopupOpen,
    activeEffects,
    effectIntensities,
    inputSource,
    isSettingBpm,
    loopClips,
    bpm,
    isMuted,
    midi.connected,
    midi.deviceName,
    playingClips,
    showHelp,
    handleInputSourceChange,
    handleIntensityChange,
    handleLoopToggle,
    handleMuteToggle,
    handlePlayToggle,
    handleCheckboxChange,
    videoPlaylist,
    currentVideoIndex,
    isVideoPlaying,
    handleVideoPlayPause,
    handleNextVideo,
    handlePreviousVideo,
    handleAddVideosToPlaylist,
    handleRemoveFromPlaylist,
    handleSeek,
    handleSeekStart,
    handleSeekEnd,
    currentTime,
    duration,
    isSeeking,
  ]);

  return (
    <div
      onContextMenu={handleContextMenu}
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        backgroundColor: "black",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <video
        ref={videoRef}
        style={{ display: "none" }}
        crossOrigin="anonymous"
      />
      {showPanel && !isPopupOpen && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            zIndex: 10,
          }}
        >
          <ControlPanel
            activeEffects={activeEffects}
            bpm={bpm}
            effectIntensities={effectIntensities}
            inputSource={inputSource}
            isSettingBpm={isSettingBpm}
            loopClips={loopClips}
            isMuted={isMuted}
            midiConnected={midi.connected}
            midiDeviceName={midi.deviceName}
            onInputSourceChange={handleInputSourceChange}
            onFileSelected={() => {}} // This function is no longer used
            onIntensityChange={handleIntensityChange}
            onLoopToggle={handleLoopToggle}
            onMuteToggle={handleMuteToggle}
            onPlayToggle={handlePlayToggle}
            onToggleEffect={handleCheckboxChange}
            onToggleHelp={() => setShowHelp((prev) => !prev)}
            playingClips={playingClips}
            showHelp={showHelp}
            videoPlaylist={videoPlaylist}
            currentVideoIndex={currentVideoIndex}
            isVideoPlaying={isVideoPlaying}
            onVideoPlayPause={handleVideoPlayPause}
            onNextVideo={handleNextVideo}
            onPreviousVideo={handlePreviousVideo}
            onAddVideosToPlaylist={handleAddVideosToPlaylist}
            onRemoveFromPlaylist={handleRemoveFromPlaylist}
            onSeek={handleSeek}
            onSeekStart={handleSeekStart}
            onSeekEnd={handleSeekEnd}
            currentTime={currentTime}
            duration={duration}
            isSeeking={isSeeking}
          />
        </div>
      )}

      {showPanel && !isPopupOpen && (
        <div
          style={{
            position: "absolute",
            top: "20px",
            right: "430px",
            zIndex: 10,
          }}
        >
          <button
            onClick={openPopupWindow}
            style={{
              backgroundColor: "#007bff",
              color: "white",
              border: "none",
              borderRadius: "4px",
              padding: "10px 16px",
              cursor: "pointer",
              fontSize: "14px",
              fontWeight: "500",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
            }}
            title="Open controls in popup window"
          >
            Pop Out Controls
          </button>
        </div>
      )}

      {showHelp && (
        <div
          style={{
            position: "absolute",
            bottom: "20px",
            width: "100%",
            textAlign: "center",
            color: "white",
            pointerEvents: "none",
          }}
        >
          <div>Right click to show controls | Spacebar to tap BPM | Q/W/E/R for beat-based clips | "Pop Out Controls" to detach panel</div>
          <div style={{ fontSize: "12px", marginTop: "5px", opacity: 0.8 }}>
            Version: {VERSION} | GPU FPS: {fps} | Frame Time: {frameTime.toFixed(2)}ms
            {midi.connected && (
              <span style={{ color: "#00ff00", marginLeft: "10px" }}>
                🎹 MIDI: {midi.deviceName}
              </span>
            )}
            {!midi.connected && (
              <span style={{ color: "#ff6666", marginLeft: "10px" }}>
                🎹 MIDI: Not connected
              </span>
            )}
          </div>
          {showMidiSyncNotification && (
            <div style={{
              fontSize: "14px",
              marginTop: "10px",
              color: "#ffff00",
              backgroundColor: "rgba(0, 0, 0, 0.8)",
              padding: "10px 20px",
              borderRadius: "4px",
              display: "inline-block",
              pointerEvents: "none",
              animation: "fadeIn 0.3s ease-in-out"
            }}>
              🎛️ MIDI Connected! Move each knob slightly to sync with current positions
            </div>
          )}
        </div>
      )}

      {popupControlPanel}
    </div>
  );
};

export default App;