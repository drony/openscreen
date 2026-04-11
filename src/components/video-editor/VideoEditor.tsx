import type { Span } from "dnd-timeline";
import { FolderOpen, Languages, Save, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { INITIAL_EDITOR_STATE, useEditorHistory } from "@/hooks/useEditorHistory";
import { type Locale, SUPPORTED_LOCALES } from "@/i18n/config";
import { getLocaleName } from "@/i18n/loader";
import {
	calculateOutputDimensions,
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportSettings,
	GIF_SIZE_PRESETS,
	GifExporter,
	type GifFrameRate,
	type GifSizePreset,
	VideoExporter,
} from "@/lib/exporter";
import { computeFrameStepTime } from "@/lib/frameStep";
import type { ProjectMedia } from "@/lib/recordingSession";
import { matchesShortcut } from "@/lib/shortcuts";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";
import {
	getAspectRatioValue,
	getNativeAspectRatioValue,
	isPortraitAspectRatio,
} from "@/utils/aspectRatioUtils";
import { buildMicrophoneTelemetryFromSource } from "./audioWaveformTelemetry";
import { ExportDialog } from "./ExportDialog";
import PlaybackControls from "./PlaybackControls";
import {
	createProjectData,
	createProjectSnapshot,
	deriveNextId,
	fromFileUrl,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "./projectPersistence";
import { SettingsPanel } from "./SettingsPanel";
import TimelineEditor from "./timeline/TimelineEditor";
import {
	type AnnotationRegion,
	type BlurData,
	type CursorTelemetryPoint,
	clampFocusToDepth,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_DATA,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_ZOOM_DEPTH,
	type FigureData,
	type MicrophoneTelemetryPoint,
	type PlaybackSpeed,
	type SpeedRegion,
	type TrimRegion,
	type WebcamAutomationValues,
	type WebcamKeyframe,
	type WebcamSegment,
	type WebcamTrack,
	type ZoomDepth,
	type ZoomFocus,
	type ZoomFocusMode,
	type ZoomRegion,
} from "./types";
import VideoPlayback, { VideoPlaybackRef } from "./VideoPlayback";
import {
	createDefaultWebcamTrack,
	createWebcamAutomationValues,
	DEFAULT_MICROPHONE_VISIBILITY_CONFIG,
	generateWebcamSegmentsFromMicrophoneTelemetry,
	normalizeWebcamTrack,
	resolveWebcamPresentation,
} from "./webcamAutomation";

const WEBCAM_POSITION_KEYFRAME_TOLERANCE_MS = 120;
const WEBCAM_SEGMENT_DURATION_MS = 2_500;

function createWebcamEntityId(prefix: "segment" | "keyframe") {
	return `${prefix}-${crypto.randomUUID()}`;
}

export default function VideoEditor() {
	const {
		state: editorState,
		pushState,
		updateState,
		commitState,
		undo,
		redo,
	} = useEditorHistory(INITIAL_EDITOR_STATE);

	const {
		zoomRegions,
		trimRegions,
		speedRegions,
		annotationRegions,
		cropRegion,
		wallpaper,
		shadowIntensity,
		showBlur,
		motionBlurAmount,
		borderRadius,
		padding,
		aspectRatio,
		webcamLayoutPreset,
		webcamMaskShape,
		webcamBorderWidth,
		webcamBorderColor,
		webcamSizePreset,
		webcamPosition,
		webcamShadowPreset,
		webcamTrack,
	} = editorState;

	// ── Non-undoable state
	const [videoPath, setVideoPath] = useState<string | null>(null);
	const [videoSourcePath, setVideoSourcePath] = useState<string | null>(null);
	const [webcamVideoPath, setWebcamVideoPath] = useState<string | null>(null);
	const [webcamVideoSourcePath, setWebcamVideoSourcePath] = useState<string | null>(null);
	const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;
	const durationRef = useRef(duration);
	durationRef.current = duration;
	const [cursorTelemetry, setCursorTelemetry] = useState<CursorTelemetryPoint[]>([]);
	const [microphoneTelemetry, setMicrophoneTelemetry] = useState<MicrophoneTelemetryPoint[]>([]);
	const [isMicrophoneTelemetryLoading, setIsMicrophoneTelemetryLoading] = useState(false);
	const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
	const [selectedTrimId, setSelectedTrimId] = useState<string | null>(null);
	const [selectedSpeedId, setSelectedSpeedId] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
	const [selectedWebcamSegmentId, setSelectedWebcamSegmentId] = useState<string | null>(null);
	const [selectedWebcamKeyframeId, setSelectedWebcamKeyframeId] = useState<string | null>(null);
	const [resolvedWebcamPosition, setResolvedWebcamPosition] = useState<{
		cx: number;
		cy: number;
	} | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [showExportDialog, setShowExportDialog] = useState(false);
	const [showNewRecordingDialog, setShowNewRecordingDialog] = useState(false);
	const [exportQuality, setExportQuality] = useState<ExportQuality>("good");
	const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(15);
	const [gifLoop, setGifLoop] = useState(true);
	const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>("medium");
	const [exportedFilePath, setExportedFilePath] = useState<string | null>(null);
	const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
	const [unsavedExport, setUnsavedExport] = useState<{
		arrayBuffer: ArrayBuffer;
		fileName: string;
		format: string;
	} | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [micAutomationConfig, setMicAutomationConfig] = useState(
		DEFAULT_MICROPHONE_VISIBILITY_CONFIG,
	);

	const playerContainerRef = useRef<HTMLDivElement>(null);
	const videoPlaybackRef = useRef<VideoPlaybackRef>(null);

	const nextZoomIdRef = useRef(1);
	const nextTrimIdRef = useRef(1);
	const nextSpeedIdRef = useRef(1);

	const { shortcuts, isMac } = useShortcuts();
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const { locale, setLocale } = useI18n();

	const nextAnnotationIdRef = useRef(1);
	const nextAnnotationZIndexRef = useRef(1);
	const exporterRef = useRef<VideoExporter | null>(null);

	const annotationOnlyRegions = useMemo(
		() => annotationRegions.filter((region) => region.type !== "blur"),
		[annotationRegions],
	);
	const blurRegions = useMemo(
		() => annotationRegions.filter((region) => region.type === "blur"),
		[annotationRegions],
	);

	const currentProjectMedia = useMemo<ProjectMedia | null>(() => {
		const screenVideoPath = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
		if (!screenVideoPath) {
			return null;
		}

		const webcamSourcePath =
			webcamVideoSourcePath ?? (webcamVideoPath ? fromFileUrl(webcamVideoPath) : null);
		return webcamSourcePath
			? { screenVideoPath, webcamVideoPath: webcamSourcePath }
			: { screenVideoPath };
	}, [videoPath, videoSourcePath, webcamVideoPath, webcamVideoSourcePath]);

	const currentTimeMs = useMemo(() => Math.round(currentTime * 1000), [currentTime]);
	const normalizedWebcamTrack = useMemo(() => normalizeWebcamTrack(webcamTrack), [webcamTrack]);
	const baseWebcamAutomationValues = useMemo(
		() =>
			createWebcamAutomationValues({
				position: webcamPosition,
				sizePreset: webcamSizePreset,
				borderWidth: webcamBorderWidth,
				borderColor: webcamBorderColor,
				maskShape: webcamMaskShape,
				shadowPreset: webcamShadowPreset,
			}),
		[
			webcamBorderColor,
			webcamBorderWidth,
			webcamMaskShape,
			webcamPosition,
			webcamShadowPreset,
			webcamSizePreset,
		],
	);
	const resolvedWebcamPresentation = useMemo(
		() =>
			resolveWebcamPresentation(currentTimeMs, baseWebcamAutomationValues, normalizedWebcamTrack),
		[currentTimeMs, baseWebcamAutomationValues, normalizedWebcamTrack],
	);
	const selectedWebcamKeyframe = useMemo(
		() =>
			selectedWebcamKeyframeId
				? (normalizedWebcamTrack?.keyframes.find(
						(keyframe) => keyframe.id === selectedWebcamKeyframeId,
					) ?? null)
				: null,
		[normalizedWebcamTrack, selectedWebcamKeyframeId],
	);
	const inspectedWebcamValues = useMemo(
		() =>
			selectedWebcamKeyframe?.values ??
			normalizedWebcamTrack?.keyframes.find((keyframe) => keyframe.timeMs === 0)?.values ??
			baseWebcamAutomationValues,
		[selectedWebcamKeyframe, normalizedWebcamTrack, baseWebcamAutomationValues],
	);
	const toBaseWebcamState = useCallback(
		(values: WebcamAutomationValues) => ({
			webcamPosition: values.position,
			webcamSizePreset: values.sizePreset,
			webcamBorderWidth: values.borderWidth,
			webcamBorderColor: values.borderColor,
			webcamMaskShape: values.maskShape,
			webcamShadowPreset: values.shadowPreset,
		}),
		[],
	);

	const ensureWebcamTrackInitialized = useCallback(
		(
			track: WebcamTrack | null,
			options?: {
				explicitBasePosition?: { cx: number; cy: number } | null;
			},
		) => {
			const normalized = normalizeWebcamTrack(track);
			if (normalized) {
				return normalized;
			}

			const durationMs = Math.max(
				1,
				Math.round(durationRef.current * 1000) ||
					Math.round(duration * 1000) ||
					WEBCAM_SEGMENT_DURATION_MS,
			);

			return createDefaultWebcamTrack(
				durationMs,
				{
					...baseWebcamAutomationValues,
					position: options?.explicitBasePosition ?? baseWebcamAutomationValues.position,
				},
				createWebcamEntityId,
			);
		},
		[baseWebcamAutomationValues, duration],
	);

	const updateSelectedOrBaseWebcamKeyframe = useCallback(
		(
			updater: (values: WebcamAutomationValues) => WebcamAutomationValues,
			mode: "push" | "update" = "push",
		) => {
			const nextTrack = ensureWebcamTrackInitialized(webcamTrack);
			const existingIndex = selectedWebcamKeyframeId
				? nextTrack.keyframes.findIndex((keyframe) => keyframe.id === selectedWebcamKeyframeId)
				: -1;
			const targetIndex =
				existingIndex >= 0
					? existingIndex
					: Math.max(
							0,
							nextTrack.keyframes.findIndex((keyframe) => keyframe.timeMs === 0),
						);

			const target = nextTrack.keyframes[targetIndex] ?? {
				id: createWebcamEntityId("keyframe"),
				timeMs: 0,
				values: baseWebcamAutomationValues,
			};
			const updatedKeyframe: WebcamKeyframe = {
				...target,
				values: createWebcamAutomationValues(updater(target.values)),
			};

			const keyframes =
				nextTrack.keyframes[targetIndex] === undefined
					? [updatedKeyframe, ...nextTrack.keyframes]
					: nextTrack.keyframes.map((keyframe, index) =>
							index === targetIndex ? updatedKeyframe : keyframe,
						);
			const nextState = { ...nextTrack, keyframes };
			const shouldSyncBaseState = updatedKeyframe.timeMs === 0 && targetIndex === 0;
			if (mode === "update") {
				updateState({
					webcamTrack: nextState,
					...(shouldSyncBaseState ? toBaseWebcamState(updatedKeyframe.values) : {}),
				});
			} else {
				pushState({
					webcamTrack: nextState,
					...(shouldSyncBaseState ? toBaseWebcamState(updatedKeyframe.values) : {}),
				});
			}
			setSelectedWebcamKeyframeId(updatedKeyframe.id);
			return updatedKeyframe.id;
		},
		[
			baseWebcamAutomationValues,
			ensureWebcamTrackInitialized,
			pushState,
			selectedWebcamKeyframeId,
			toBaseWebcamState,
			updateState,
			webcamTrack,
		],
	);

	const upsertWebcamKeyframeAtCurrentTime = useCallback(
		(
			overrides: Partial<WebcamAutomationValues>,
			mode: "push" | "update" = "push",
			toleranceMs = WEBCAM_POSITION_KEYFRAME_TOLERANCE_MS,
		) => {
			const explicitBasePosition = resolvedWebcamPosition ?? resolvedWebcamPresentation.position;
			const nextTrack = ensureWebcamTrackInitialized(webcamTrack, { explicitBasePosition });
			const existingIndex = nextTrack.keyframes.findIndex(
				(keyframe) => Math.abs(keyframe.timeMs - currentTimeMs) <= toleranceMs,
			);
			const snapshotValues = createWebcamAutomationValues({
				position: resolvedWebcamPresentation.position ?? explicitBasePosition,
				sizePreset: resolvedWebcamPresentation.sizePreset,
				borderWidth: resolvedWebcamPresentation.borderWidth,
				borderColor: resolvedWebcamPresentation.borderColor,
				maskShape: resolvedWebcamPresentation.maskShape,
				shadowPreset: resolvedWebcamPresentation.shadowPreset,
				...overrides,
			});

			const updatedKeyframe: WebcamKeyframe =
				existingIndex >= 0
					? {
							...nextTrack.keyframes[existingIndex],
							values: snapshotValues,
						}
					: {
							id: createWebcamEntityId("keyframe"),
							timeMs: currentTimeMs,
							values: snapshotValues,
						};
			const keyframes =
				existingIndex >= 0
					? nextTrack.keyframes.map((keyframe, index) =>
							index === existingIndex ? updatedKeyframe : keyframe,
						)
					: [...nextTrack.keyframes, updatedKeyframe].sort((a, b) => a.timeMs - b.timeMs);
			const nextState = { ...nextTrack, keyframes };
			const shouldSyncBaseState = updatedKeyframe.timeMs === 0;

			if (mode === "update") {
				updateState({
					webcamTrack: nextState,
					...(shouldSyncBaseState ? toBaseWebcamState(updatedKeyframe.values) : {}),
				});
			} else {
				pushState({
					webcamTrack: nextState,
					...(shouldSyncBaseState ? toBaseWebcamState(updatedKeyframe.values) : {}),
				});
			}
			setSelectedWebcamKeyframeId(updatedKeyframe.id);
			return updatedKeyframe.id;
		},
		[
			currentTimeMs,
			ensureWebcamTrackInitialized,
			pushState,
			resolvedWebcamPosition,
			resolvedWebcamPresentation,
			toBaseWebcamState,
			updateState,
			webcamTrack,
		],
	);

	const applyLoadedProject = useCallback(
		async (candidate: unknown, path?: string | null) => {
			if (!validateProjectData(candidate)) {
				return false;
			}

			const project = candidate;
			const media = resolveProjectMedia(project);
			if (!media) {
				return false;
			}
			const sourcePath = fromFileUrl(media.screenVideoPath);
			const webcamSourcePath = media.webcamVideoPath ? fromFileUrl(media.webcamVideoPath) : null;
			const normalizedEditor = normalizeProjectEditor(project.editor);

			try {
				videoPlaybackRef.current?.pause();
			} catch {
				// no-op
			}
			setIsPlaying(false);
			setCurrentTime(0);
			setDuration(0);

			setError(null);
			setVideoSourcePath(sourcePath);
			setVideoPath(toFileUrl(sourcePath));
			setWebcamVideoSourcePath(webcamSourcePath);
			setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
			setCurrentProjectPath(path ?? null);

			pushState({
				wallpaper: normalizedEditor.wallpaper,
				shadowIntensity: normalizedEditor.shadowIntensity,
				showBlur: normalizedEditor.showBlur,
				motionBlurAmount: normalizedEditor.motionBlurAmount,
				borderRadius: normalizedEditor.borderRadius,
				padding: normalizedEditor.padding,
				cropRegion: normalizedEditor.cropRegion,
				zoomRegions: normalizedEditor.zoomRegions,
				trimRegions: normalizedEditor.trimRegions,
				speedRegions: normalizedEditor.speedRegions,
				annotationRegions: normalizedEditor.annotationRegions,
				aspectRatio: normalizedEditor.aspectRatio,
				webcamLayoutPreset: normalizedEditor.webcamLayoutPreset,
				webcamMaskShape: normalizedEditor.webcamMaskShape,
				webcamBorderWidth: normalizedEditor.webcamBorderWidth,
				webcamBorderColor: normalizedEditor.webcamBorderColor,
				webcamSizePreset: normalizedEditor.webcamSizePreset,
				webcamPosition: normalizedEditor.webcamPosition,
				webcamShadowPreset: normalizedEditor.webcamShadowPreset,
				webcamTrack: normalizedEditor.webcamTrack,
			});
			setExportQuality(normalizedEditor.exportQuality);
			setExportFormat(normalizedEditor.exportFormat);
			setGifFrameRate(normalizedEditor.gifFrameRate);
			setGifLoop(normalizedEditor.gifLoop);
			setGifSizePreset(normalizedEditor.gifSizePreset);

			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
			setResolvedWebcamPosition(null);

			nextZoomIdRef.current = deriveNextId(
				"zoom",
				normalizedEditor.zoomRegions.map((region) => region.id),
			);
			nextTrimIdRef.current = deriveNextId(
				"trim",
				normalizedEditor.trimRegions.map((region) => region.id),
			);
			nextSpeedIdRef.current = deriveNextId(
				"speed",
				normalizedEditor.speedRegions.map((region) => region.id),
			);
			nextAnnotationIdRef.current = deriveNextId(
				"annotation",
				normalizedEditor.annotationRegions.map((region) => region.id),
			);
			nextAnnotationZIndexRef.current =
				normalizedEditor.annotationRegions.reduce(
					(max, region) => Math.max(max, region.zIndex),
					0,
				) + 1;

			setLastSavedSnapshot(
				createProjectSnapshot(
					webcamSourcePath
						? { screenVideoPath: sourcePath, webcamVideoPath: webcamSourcePath }
						: { screenVideoPath: sourcePath },
					normalizedEditor,
				),
			);
			return true;
		},
		[pushState],
	);

	const currentProjectSnapshot = useMemo(() => {
		if (!currentProjectMedia) {
			return null;
		}
		return createProjectSnapshot(currentProjectMedia, {
			wallpaper,
			shadowIntensity,
			showBlur,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			zoomRegions,
			trimRegions,
			speedRegions,
			annotationRegions,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamBorderWidth,
			webcamBorderColor,
			webcamSizePreset,
			webcamPosition,
			webcamShadowPreset,
			webcamTrack: normalizedWebcamTrack,
			exportQuality,
			exportFormat,
			gifFrameRate,
			gifLoop,
			gifSizePreset,
		});
	}, [
		currentProjectMedia,
		wallpaper,
		shadowIntensity,
		showBlur,
		motionBlurAmount,
		borderRadius,
		padding,
		cropRegion,
		zoomRegions,
		trimRegions,
		speedRegions,
		annotationRegions,
		aspectRatio,
		webcamLayoutPreset,
		webcamMaskShape,
		webcamBorderWidth,
		webcamBorderColor,
		webcamSizePreset,
		webcamPosition,
		webcamShadowPreset,
		normalizedWebcamTrack,
		exportQuality,
		exportFormat,
		gifFrameRate,
		gifLoop,
		gifSizePreset,
	]);

	const hasUnsavedChanges = hasProjectUnsavedChanges(currentProjectSnapshot, lastSavedSnapshot);

	useEffect(() => {
		async function loadInitialData() {
			try {
				const currentProjectResult = await window.electronAPI.loadCurrentProjectFile();
				if (currentProjectResult.success && currentProjectResult.project) {
					const restored = await applyLoadedProject(
						currentProjectResult.project,
						currentProjectResult.path ?? null,
					);
					if (restored) {
						return;
					}
				}

				const currentSessionResult = await window.electronAPI.getCurrentRecordingSession();
				if (currentSessionResult.success && currentSessionResult.session) {
					const session = currentSessionResult.session;
					const sourcePath = fromFileUrl(session.screenVideoPath);
					const webcamSourcePath = session.webcamVideoPath
						? fromFileUrl(session.webcamVideoPath)
						: null;
					setVideoSourcePath(sourcePath);
					setVideoPath(toFileUrl(sourcePath));
					setWebcamVideoSourcePath(webcamSourcePath);
					setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
					setCurrentProjectPath(null);
					setLastSavedSnapshot(
						createProjectSnapshot(
							webcamSourcePath
								? { screenVideoPath: sourcePath, webcamVideoPath: webcamSourcePath }
								: { screenVideoPath: sourcePath },
							INITIAL_EDITOR_STATE,
						),
					);
					return;
				}

				const result = await window.electronAPI.getCurrentVideoPath();
				if (result.success && result.path) {
					const sourcePath = fromFileUrl(result.path);
					setVideoSourcePath(sourcePath);
					setVideoPath(toFileUrl(sourcePath));
					setWebcamVideoSourcePath(null);
					setWebcamVideoPath(null);
					setCurrentProjectPath(null);
					setLastSavedSnapshot(
						createProjectSnapshot({ screenVideoPath: sourcePath }, INITIAL_EDITOR_STATE),
					);
				} else {
					setError("No video to load. Please record or select a video.");
				}
			} catch (err) {
				setError("Error loading video: " + String(err));
			} finally {
				setLoading(false);
			}
		}

		loadInitialData();
	}, [applyLoadedProject]);

	// Track whether user preferences have been loaded to avoid
	// overwriting saved prefs with defaults on the first render
	const [prefsHydrated, setPrefsHydrated] = useState(false);

	// Load persisted user preferences on mount (intentionally runs once)
	useEffect(() => {
		const prefs = loadUserPreferences();
		updateState({
			padding: prefs.padding,
			aspectRatio: prefs.aspectRatio,
		});
		setExportQuality(prefs.exportQuality);
		setExportFormat(prefs.exportFormat);
		setPrefsHydrated(true);
	}, [updateState]);

	// Auto-save user preferences when settings change
	useEffect(() => {
		if (!prefsHydrated) return;
		saveUserPreferences({ padding, aspectRatio, exportQuality, exportFormat });
	}, [prefsHydrated, padding, aspectRatio, exportQuality, exportFormat]);

	const saveProject = useCallback(
		async (forceSaveAs: boolean) => {
			if (!videoPath) {
				toast.error(t("errors.noVideoLoaded"));
				return false;
			}

			if (!currentProjectMedia) {
				toast.error(t("errors.unableToDetermineSourcePath"));
				return false;
			}

			const projectData = createProjectData(currentProjectMedia, {
				wallpaper,
				shadowIntensity,
				showBlur,
				motionBlurAmount,
				borderRadius,
				padding,
				cropRegion,
				zoomRegions,
				trimRegions,
				speedRegions,
				annotationRegions,
				aspectRatio,
				webcamLayoutPreset,
				webcamMaskShape,
				webcamBorderWidth,
				webcamBorderColor,
				webcamSizePreset,
				webcamPosition,
				webcamShadowPreset,
				webcamTrack: normalizedWebcamTrack,
				exportQuality,
				exportFormat,
				gifFrameRate,
				gifLoop,
				gifSizePreset,
			});

			const fileNameBase =
				currentProjectMedia.screenVideoPath
					.split(/[\\/]/)
					.pop()
					?.replace(/\.[^.]+$/, "") || `project-${Date.now()}`;
			const projectSnapshot = JSON.stringify(projectData);
			const result = await window.electronAPI.saveProjectFile(
				projectData,
				fileNameBase,
				forceSaveAs ? undefined : (currentProjectPath ?? undefined),
			);

			if (result.canceled) {
				toast.info(t("project.saveCanceled"));
				return false;
			}

			if (!result.success) {
				toast.error(result.message || t("project.failedToSave"));
				return false;
			}

			if (result.path) {
				setCurrentProjectPath(result.path);
			}
			setLastSavedSnapshot(projectSnapshot);

			toast.success(t("project.savedTo", { path: result.path ?? "" }));
			return true;
		},
		[
			currentProjectMedia,
			currentProjectPath,
			wallpaper,
			shadowIntensity,
			showBlur,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			zoomRegions,
			trimRegions,
			speedRegions,
			annotationRegions,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamBorderWidth,
			webcamBorderColor,
			webcamSizePreset,
			webcamPosition,
			webcamShadowPreset,
			normalizedWebcamTrack,
			exportQuality,
			exportFormat,
			gifFrameRate,
			gifLoop,
			gifSizePreset,
			videoPath,
			t,
		],
	);

	useEffect(() => {
		window.electronAPI.setHasUnsavedChanges(hasUnsavedChanges);
	}, [hasUnsavedChanges]);

	useEffect(() => {
		const cleanup = window.electronAPI.onRequestSaveBeforeClose(async () => {
			return saveProject(false);
		});
		return () => cleanup();
	}, [saveProject]);

	const handleSaveProject = useCallback(async () => {
		await saveProject(false);
	}, [saveProject]);

	const handleSaveProjectAs = useCallback(async () => {
		await saveProject(true);
	}, [saveProject]);

	const handleNewRecordingConfirm = useCallback(async () => {
		const result = await window.electronAPI.startNewRecording();
		if (result.success) {
			setShowNewRecordingDialog(false);
		} else {
			console.error("Failed to start new recording:", result.error);
			setError("Failed to start new recording: " + (result.error || "Unknown error"));
		}
	}, []);

	const handleLoadProject = useCallback(async () => {
		const result = await window.electronAPI.loadProjectFile();

		if (result.canceled) {
			return;
		}

		if (!result.success) {
			toast.error(result.message || "Failed to load project");
			return;
		}

		const restored = await applyLoadedProject(result.project, result.path ?? null);
		if (!restored) {
			toast.error("Invalid project file format");
			return;
		}

		toast.success(`Project loaded from ${result.path}`);
	}, [applyLoadedProject]);

	useEffect(() => {
		const removeLoadListener = window.electronAPI.onMenuLoadProject(handleLoadProject);
		const removeSaveListener = window.electronAPI.onMenuSaveProject(handleSaveProject);
		const removeSaveAsListener = window.electronAPI.onMenuSaveProjectAs(handleSaveProjectAs);

		return () => {
			removeLoadListener?.();
			removeSaveListener?.();
			removeSaveAsListener?.();
		};
	}, [handleLoadProject, handleSaveProject, handleSaveProjectAs]);

	useEffect(() => {
		let mounted = true;

		async function loadCursorTelemetry() {
			const sourcePath = currentProjectMedia?.screenVideoPath ?? null;

			if (!sourcePath) {
				if (mounted) {
					setCursorTelemetry([]);
				}
				return;
			}

			try {
				const result = await window.electronAPI.getCursorTelemetry(sourcePath);
				if (mounted) {
					setCursorTelemetry(result.success ? result.samples : []);
				}
			} catch (telemetryError) {
				console.warn("Unable to load cursor telemetry:", telemetryError);
				if (mounted) {
					setCursorTelemetry([]);
				}
			}
		}

		loadCursorTelemetry();

		return () => {
			mounted = false;
		};
	}, [currentProjectMedia]);

	useEffect(() => {
		let mounted = true;

		async function loadMicrophoneTelemetry() {
			const sourcePath = currentProjectMedia?.screenVideoPath ?? null;

			if (!sourcePath) {
				if (mounted) {
					setMicrophoneTelemetry([]);
					setIsMicrophoneTelemetryLoading(false);
				}
				return;
			}

			if (mounted) {
				setIsMicrophoneTelemetryLoading(true);
			}

			try {
				let samples = await buildMicrophoneTelemetryFromSource(sourcePath);

				if (samples.length === 0) {
					const result = await window.electronAPI.getMicrophoneTelemetry(sourcePath);
					samples = result.success ? result.samples : [];
				}

				if (mounted) {
					setMicrophoneTelemetry(samples);
				}
			} catch (telemetryError) {
				console.warn("Unable to load microphone telemetry:", telemetryError);
				if (mounted) {
					try {
						const result = await window.electronAPI.getMicrophoneTelemetry(sourcePath);
						if (mounted) {
							setMicrophoneTelemetry(result.success ? result.samples : []);
						}
					} catch (fallbackError) {
						console.warn("Unable to load microphone telemetry fallback:", fallbackError);
						if (mounted) {
							setMicrophoneTelemetry([]);
						}
					}
				}
			} finally {
				if (mounted) {
					setIsMicrophoneTelemetryLoading(false);
				}
			}
		}

		loadMicrophoneTelemetry();

		return () => {
			mounted = false;
		};
	}, [currentProjectMedia]);

	function togglePlayPause() {
		const playback = videoPlaybackRef.current;
		const video = playback?.video;
		if (!playback || !video) return;

		if (isPlaying) {
			playback.pause();
		} else {
			playback.play().catch((err) => console.error("Video play failed:", err));
		}
	}

	const toggleFullscreen = useCallback(() => {
		setIsFullscreen((prev) => !prev);
	}, []);

	useEffect(() => {
		if (!isFullscreen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsFullscreen(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isFullscreen]);

	function handleSeek(time: number) {
		const video = videoPlaybackRef.current?.video;
		if (!video) return;
		video.currentTime = time;
	}

	const handleSelectZoom = useCallback((id: string | null) => {
		setSelectedZoomId(id);
		if (id) {
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		}
	}, []);

	const handleSelectTrim = useCallback((id: string | null) => {
		setSelectedTrimId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		}
	}, []);

	const handleSelectAnnotation = useCallback((id: string | null) => {
		setSelectedAnnotationId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		}
	}, []);

	const handleSelectBlur = useCallback((id: string | null) => {
		setSelectedBlurId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		}
	}, []);

	const handleZoomAdded = useCallback(
		(span: Span) => {
			const id = `zoom-${nextZoomIdRef.current++}`;
			const newRegion: ZoomRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				focus: { cx: 0.5, cy: 0.5 },
			};
			pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, newRegion] }));
			setSelectedZoomId(id);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleZoomSuggested = useCallback(
		(span: Span, focus: ZoomFocus) => {
			const id = `zoom-${nextZoomIdRef.current++}`;
			const newRegion: ZoomRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				focus: clampFocusToDepth(focus, DEFAULT_ZOOM_DEPTH),
			};
			pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, newRegion] }));
			setSelectedZoomId(id);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleTrimAdded = useCallback(
		(span: Span) => {
			const id = `trim-${nextTrimIdRef.current++}`;
			const newRegion: TrimRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
			};
			pushState((prev) => ({ trimRegions: [...prev.trimRegions, newRegion] }));
			setSelectedTrimId(id);
			setSelectedZoomId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleZoomSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleTrimSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	// Focus drag: updateState for live preview, commitState on pointer-up
	const handleZoomFocusChange = useCallback(
		(id: string, focus: ZoomFocus) => {
			updateState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id ? { ...region, focus: clampFocusToDepth(focus, region.depth) } : region,
				),
			}));
		},
		[updateState],
	);

	const handleZoomDepthChange = useCallback(
		(depth: ZoomDepth) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId
						? {
								...region,
								depth,
								focus: clampFocusToDepth(region.focus, depth),
							}
						: region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomFocusModeChange = useCallback(
		(focusMode: ZoomFocusMode) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId ? { ...region, focusMode } : region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.filter((r) => r.id !== id),
			}));
			if (selectedZoomId === id) {
				setSelectedZoomId(null);
			}
		},
		[selectedZoomId, pushState],
	);

	const handleTrimDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.filter((r) => r.id !== id),
			}));
			if (selectedTrimId === id) {
				setSelectedTrimId(null);
			}
		},
		[selectedTrimId, pushState],
	);

	const handleSelectSpeed = useCallback((id: string | null) => {
		setSelectedSpeedId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		}
	}, []);

	const handleSelectWebcamSegment = useCallback((id: string | null) => {
		setSelectedWebcamSegmentId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
		}
	}, []);

	const handleSelectWebcamKeyframe = useCallback((id: string | null) => {
		setSelectedWebcamKeyframeId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
		}
	}, []);

	const handleAddWebcamSegment = useCallback(() => {
		if (!webcamVideoPath) {
			return;
		}

		const durationMs = Math.max(
			1,
			Math.round(durationRef.current * 1000) || WEBCAM_SEGMENT_DURATION_MS,
		);
		const track = ensureWebcamTrackInitialized(webcamTrack, {
			explicitBasePosition: resolvedWebcamPosition ?? resolvedWebcamPresentation.position,
		});
		const existing = track.segments.find(
			(segment) => currentTimeMs >= segment.startMs && currentTimeMs <= segment.endMs,
		);
		if (existing) {
			handleSelectWebcamSegment(existing.id);
			return;
		}

		const sorted = [...track.segments].sort((a, b) => a.startMs - b.startMs);
		const startMs = Math.max(0, Math.min(currentTimeMs, Math.max(durationMs - 1, 0)));
		const nextSegment = sorted.find((segment) => segment.startMs > startMs) ?? null;
		const gapEnd = nextSegment ? nextSegment.startMs : durationMs;
		const endMs = Math.min(gapEnd, startMs + WEBCAM_SEGMENT_DURATION_MS);
		if (endMs - startMs < 1) {
			return;
		}

		const segment: WebcamSegment = {
			id: createWebcamEntityId("segment"),
			startMs,
			endMs,
		};
		const nextTrack: WebcamTrack = {
			...track,
			segments: [...track.segments, segment].sort((a, b) => a.startMs - b.startMs),
		};
		pushState({ webcamTrack: nextTrack });
		setSelectedWebcamSegmentId(segment.id);
	}, [
		currentTimeMs,
		ensureWebcamTrackInitialized,
		handleSelectWebcamSegment,
		pushState,
		resolvedWebcamPosition,
		resolvedWebcamPresentation.position,
		webcamTrack,
		webcamVideoPath,
	]);

	const handleWebcamSegmentSpanChange = useCallback(
		(id: string, span: Span) => {
			const track = ensureWebcamTrackInitialized(webcamTrack, {
				explicitBasePosition: resolvedWebcamPosition ?? resolvedWebcamPresentation.position,
			});
			pushState({
				webcamTrack: {
					...track,
					segments: track.segments
						.map((segment) =>
							segment.id === id
								? {
										...segment,
										startMs: Math.max(0, Math.round(span.start)),
										endMs: Math.max(Math.round(span.start) + 1, Math.round(span.end)),
									}
								: segment,
						)
						.sort((a, b) => a.startMs - b.startMs),
				},
			});
		},
		[
			ensureWebcamTrackInitialized,
			pushState,
			resolvedWebcamPosition,
			resolvedWebcamPresentation.position,
			webcamTrack,
		],
	);

	const handleWebcamSegmentDelete = useCallback(
		(id: string) => {
			if (!normalizedWebcamTrack) {
				return;
			}
			pushState({
				webcamTrack: {
					...normalizedWebcamTrack,
					segments: normalizedWebcamTrack.segments.filter((segment) => segment.id !== id),
				},
			});
			if (selectedWebcamSegmentId === id) {
				setSelectedWebcamSegmentId(null);
			}
		},
		[normalizedWebcamTrack, pushState, selectedWebcamSegmentId],
	);

	const handleAddWebcamKeyframe = useCallback(() => {
		if (!webcamVideoPath) {
			return;
		}
		upsertWebcamKeyframeAtCurrentTime({}, "push", 0);
	}, [upsertWebcamKeyframeAtCurrentTime, webcamVideoPath]);

	const handleWebcamKeyframeMove = useCallback(
		(id: string, newTimeMs: number) => {
			if (!normalizedWebcamTrack) {
				return;
			}

			updateState({
				webcamTrack: {
					...normalizedWebcamTrack,
					keyframes: normalizedWebcamTrack.keyframes
						.map((keyframe) =>
							keyframe.id === id
								? {
										...keyframe,
										timeMs: Math.max(0, Math.round(newTimeMs)),
									}
								: keyframe,
						)
						.sort((a, b) => a.timeMs - b.timeMs),
				},
			});
			setSelectedWebcamKeyframeId(id);
		},
		[normalizedWebcamTrack, updateState],
	);

	const handleWebcamKeyframeDelete = useCallback(
		(id: string) => {
			if (!normalizedWebcamTrack) {
				return;
			}
			pushState({
				webcamTrack: {
					...normalizedWebcamTrack,
					keyframes: normalizedWebcamTrack.keyframes.filter((keyframe) => keyframe.id !== id),
				},
			});
			if (selectedWebcamKeyframeId === id) {
				setSelectedWebcamKeyframeId(null);
			}
		},
		[normalizedWebcamTrack, pushState, selectedWebcamKeyframeId],
	);

	const handleWebcamAnchorSelect = useCallback(
		(anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center") => {
			const positions: Record<typeof anchor, { cx: number; cy: number }> = {
				"top-left": { cx: 0.18, cy: 0.18 },
				"top-right": { cx: 0.82, cy: 0.18 },
				"bottom-left": { cx: 0.18, cy: 0.82 },
				"bottom-right": { cx: 0.82, cy: 0.82 },
				center: { cx: 0.5, cy: 0.5 },
			};
			upsertWebcamKeyframeAtCurrentTime({ position: positions[anchor] }, "push", 0);
		},
		[upsertWebcamKeyframeAtCurrentTime],
	);

	const handleGenerateWebcamVisibilityFromMic = useCallback(
		(config: typeof DEFAULT_MICROPHONE_VISIBILITY_CONFIG) => {
			if (!webcamVideoPath) {
				return;
			}

			const durationMs = Math.max(
				1,
				Math.round(durationRef.current * 1000) || WEBCAM_SEGMENT_DURATION_MS,
			);
			const track = ensureWebcamTrackInitialized(webcamTrack, {
				explicitBasePosition: resolvedWebcamPosition ?? resolvedWebcamPresentation.position,
			});
			const segments = generateWebcamSegmentsFromMicrophoneTelemetry(
				microphoneTelemetry,
				durationMs,
				config,
				() => createWebcamEntityId("segment"),
			);
			pushState({
				webcamTrack: {
					...track,
					segments,
				},
			});
			setSelectedWebcamSegmentId(segments[0]?.id ?? null);
		},
		[
			ensureWebcamTrackInitialized,
			microphoneTelemetry,
			pushState,
			resolvedWebcamPosition,
			resolvedWebcamPresentation.position,
			webcamTrack,
			webcamVideoPath,
		],
	);

	const handleSpeedAdded = useCallback(
		(span: Span) => {
			const id = `speed-${nextSpeedIdRef.current++}`;
			const newRegion: SpeedRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				speed: DEFAULT_PLAYBACK_SPEED,
			};
			pushState((prev) => ({
				speedRegions: [...prev.speedRegions, newRegion],
			}));
			setSelectedSpeedId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleSpeedSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleSpeedDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.filter((region) => region.id !== id),
			}));
			if (selectedSpeedId === id) {
				setSelectedSpeedId(null);
			}
		},
		[selectedSpeedId, pushState],
	);

	const handleSpeedChange = useCallback(
		(speed: PlaybackSpeed) => {
			if (!selectedSpeedId) return;
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === selectedSpeedId ? { ...region, speed } : region,
				),
			}));
		},
		[selectedSpeedId, pushState],
	);

	const handleAnnotationAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "text",
				content: "Enter text...",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedAnnotationId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedBlurId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleBlurAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "blur",
				content: "",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
				blurData: { ...DEFAULT_BLUR_DATA },
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedBlurId(id);
			setSelectedAnnotationId(null);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedWebcamSegmentId(null);
			setSelectedWebcamKeyframeId(null);
		},
		[pushState],
	);

	const handleAnnotationSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.filter((r) => r.id !== id),
			}));
			if (selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
			}
			if (selectedBlurId === id) {
				setSelectedBlurId(null);
			}
		},
		[selectedAnnotationId, selectedBlurId, pushState],
	);

	const handleAnnotationContentChange = useCallback(
		(id: string, content: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					if (region.type === "text") {
						return { ...region, content, textContent: content };
					} else if (region.type === "image") {
						return { ...region, content, imageContent: content };
					}
					return { ...region, content };
				}),
			}));
		},
		[pushState],
	);

	const handleAnnotationTypeChange = useCallback(
		(id: string, type: AnnotationRegion["type"]) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					const updatedRegion = { ...region, type };
					if (type === "text") {
						updatedRegion.content = region.textContent || "Enter text...";
					} else if (type === "image") {
						updatedRegion.content = region.imageContent || "";
					} else if (type === "figure") {
						updatedRegion.content = "";
						if (!region.figureData) {
							updatedRegion.figureData = { ...DEFAULT_FIGURE_DATA };
						}
					} else if (type === "blur") {
						updatedRegion.content = "";
						if (!region.blurData) {
							updatedRegion.blurData = { ...DEFAULT_BLUR_DATA };
						}
					}
					return updatedRegion;
				}),
			}));

			if (type === "blur" && selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
				setSelectedBlurId(id);
				setSelectedSpeedId(null);
			} else if (type !== "blur" && selectedBlurId === id) {
				setSelectedBlurId(null);
				setSelectedAnnotationId(id);
			}
		},
		[pushState, selectedAnnotationId, selectedBlurId],
	);

	const handleAnnotationStyleChange = useCallback(
		(id: string, style: Partial<AnnotationRegion["style"]>) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? { ...region, style: { ...region.style, ...style } } : region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationFigureDataChange = useCallback(
		(id: string, figureData: FigureData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? { ...region, figureData } : region,
				),
			}));
		},
		[pushState],
	);

	const handleBlurDataPreviewChange = useCallback(
		(id: string, blurData: BlurData) => {
			updateState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								// Freehand drawing area is the full video surface.
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[updateState],
	);

	const handleBlurDataPanelChange = useCallback(
		(id: string, blurData: BlurData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationPositionChange = useCallback(
		(id: string, position: { x: number; y: number }) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? { ...region, position } : region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationSizeChange = useCallback(
		(id: string, size: { width: number; height: number }) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? { ...region, size } : region,
				),
			}));
		},
		[pushState],
	);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			const key = e.key.toLowerCase();

			if (mod && key === "z" && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				undo();
				return;
			}
			if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
				e.preventDefault();
				e.stopPropagation();
				redo();
				return;
			}

			// Frame-step navigation (arrow keys, no modifiers)
			if (
				(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.shiftKey &&
				!e.altKey
			) {
				const target = e.target;
				if (
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target instanceof HTMLSelectElement ||
					(target instanceof HTMLElement &&
						(target.isContentEditable ||
							target.closest('[role="separator"], [role="slider"], [role="spinbutton"]')))
				) {
					return;
				}
				e.preventDefault();
				const video = videoPlaybackRef.current?.video;
				if (!video) {
					return;
				}
				const direction = e.key === "ArrowLeft" ? "backward" : "forward";
				const newTime = computeFrameStepTime(
					video.currentTime,
					Number.isFinite(video.duration) ? video.duration : durationRef.current,
					direction,
				);
				video.currentTime = newTime;
				return;
			}

			const isInput =
				e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

			if (e.key === "Tab" && !isInput) {
				e.preventDefault();
			}

			if (matchesShortcut(e, shortcuts.playPause, isMac)) {
				// Allow space only in inputs/textareas
				if (isInput) {
					return;
				}
				e.preventDefault();
				const playback = videoPlaybackRef.current;
				if (playback?.video) {
					playback.video.paused ? playback.play().catch(console.error) : playback.pause();
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [undo, redo, shortcuts, isMac]);

	useEffect(() => {
		if (selectedZoomId && !zoomRegions.some((region) => region.id === selectedZoomId)) {
			setSelectedZoomId(null);
		}
	}, [selectedZoomId, zoomRegions]);

	useEffect(() => {
		if (selectedTrimId && !trimRegions.some((region) => region.id === selectedTrimId)) {
			setSelectedTrimId(null);
		}
	}, [selectedTrimId, trimRegions]);

	useEffect(() => {
		if (
			selectedAnnotationId &&
			!annotationOnlyRegions.some((region) => region.id === selectedAnnotationId)
		) {
			setSelectedAnnotationId(null);
		}
		if (selectedBlurId && !blurRegions.some((region) => region.id === selectedBlurId)) {
			setSelectedBlurId(null);
		}
	}, [selectedAnnotationId, selectedBlurId, annotationOnlyRegions, blurRegions]);

	useEffect(() => {
		if (selectedSpeedId && !speedRegions.some((region) => region.id === selectedSpeedId)) {
			setSelectedSpeedId(null);
		}
	}, [selectedSpeedId, speedRegions]);

	useEffect(() => {
		if (
			selectedWebcamSegmentId &&
			!normalizedWebcamTrack?.segments.some((segment) => segment.id === selectedWebcamSegmentId)
		) {
			setSelectedWebcamSegmentId(null);
		}
		if (
			selectedWebcamKeyframeId &&
			!normalizedWebcamTrack?.keyframes.some((keyframe) => keyframe.id === selectedWebcamKeyframeId)
		) {
			setSelectedWebcamKeyframeId(null);
		}
	}, [normalizedWebcamTrack, selectedWebcamKeyframeId, selectedWebcamSegmentId]);

	const handleShowExportedFile = useCallback(async (filePath: string) => {
		try {
			const result = await window.electronAPI.revealInFolder(filePath);
			if (!result.success) {
				const errorMessage = result.error || result.message || "Failed to reveal item in folder.";
				console.error("Failed to reveal in folder:", errorMessage);
				toast.error(errorMessage);
			}
		} catch (error) {
			const errorMessage = String(error);
			console.error("Error calling revealInFolder IPC:", errorMessage);
			toast.error(`Error revealing in folder: ${errorMessage}`);
		}
	}, []);

	const handleExportSaved = useCallback(
		(formatLabel: "GIF" | "Video", filePath: string) => {
			setExportedFilePath(filePath);
			toast.success(`${formatLabel} exported successfully`, {
				description: filePath,
				action: {
					label: "Show in Folder",
					onClick: () => {
						void handleShowExportedFile(filePath);
					},
				},
			});
		},
		[handleShowExportedFile],
	);

	const handleSaveUnsavedExport = useCallback(async () => {
		if (!unsavedExport) return;
		try {
			const saveResult = await window.electronAPI.saveExportedVideo(
				unsavedExport.arrayBuffer,
				unsavedExport.fileName,
			);
			if (saveResult.canceled) {
				toast.info("Export canceled");
			} else if (saveResult.success && saveResult.path) {
				setUnsavedExport(null);
				handleExportSaved(unsavedExport.format === "gif" ? "GIF" : "Video", saveResult.path);
			} else {
				toast.error(saveResult.message || "Failed to save export");
			}
		} catch (error) {
			console.error("Error saving unsaved export:", error);
			toast.error("Failed to save exported video");
		}
	}, [unsavedExport, handleExportSaved]);

	const handleExport = useCallback(
		async (settings: ExportSettings) => {
			if (!videoPath) {
				toast.error("No video loaded");
				return;
			}

			const video = videoPlaybackRef.current?.video;
			if (!video) {
				toast.error("Video not ready");
				return;
			}

			setIsExporting(true);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);

			try {
				const wasPlaying = isPlaying;
				if (wasPlaying) {
					videoPlaybackRef.current?.pause();
				}

				const sourceWidth = video.videoWidth || 1920;
				const sourceHeight = video.videoHeight || 1080;
				const aspectRatioValue =
					aspectRatio === "native"
						? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
						: getAspectRatioValue(aspectRatio);

				// Get preview CONTAINER dimensions for scaling
				const playbackRef = videoPlaybackRef.current;
				const containerElement = playbackRef?.containerRef?.current;
				const previewWidth = containerElement?.clientWidth || 1920;
				const previewHeight = containerElement?.clientHeight || 1080;

				if (settings.format === "gif" && settings.gifConfig) {
					// GIF Export
					const gifExporter = new GifExporter({
						videoUrl: videoPath,
						webcamVideoUrl: webcamVideoPath || undefined,
						width: settings.gifConfig.width,
						height: settings.gifConfig.height,
						frameRate: settings.gifConfig.frameRate,
						loop: settings.gifConfig.loop,
						sizePreset: settings.gifConfig.sizePreset,
						wallpaper,
						zoomRegions,
						trimRegions,
						speedRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						borderRadius,
						padding,
						videoPadding: padding,
						cropRegion,
						annotationRegions,
						webcamLayoutPreset,
						webcamMaskShape,
						webcamBorderWidth,
						webcamBorderColor,
						webcamSizePreset,
						webcamPosition,
						webcamShadowPreset,
						webcamTrack: normalizedWebcamTrack,
						previewWidth,
						previewHeight,
						cursorTelemetry,
						onProgress: (progress: ExportProgress) => {
							setExportProgress(progress);
						},
					});

					exporterRef.current = gifExporter as unknown as VideoExporter;
					const result = await gifExporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();
						const timestamp = Date.now();
						const fileName = `export-${timestamp}.gif`;

						const saveResult = await window.electronAPI.saveExportedVideo(arrayBuffer, fileName);

						if (saveResult.canceled) {
							setUnsavedExport({ arrayBuffer, fileName, format: "gif" });
							toast.info("Export canceled");
						} else if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							handleExportSaved("GIF", saveResult.path);
						} else {
							setExportError(saveResult.message || "Failed to save GIF");
							toast.error(saveResult.message || "Failed to save GIF");
						}
					} else {
						setExportError(result.error || "GIF export failed");
						toast.error(result.error || "GIF export failed");
					}
				} else {
					// MP4 Export
					const quality = settings.quality || exportQuality;
					let exportWidth: number;
					let exportHeight: number;
					let bitrate: number;

					if (quality === "source") {
						// Use source resolution
						exportWidth = sourceWidth;
						exportHeight = sourceHeight;

						if (aspectRatioValue === 1) {
							// Square (1:1): use smaller dimension to avoid codec limits
							const baseDimension = Math.floor(Math.min(sourceWidth, sourceHeight) / 2) * 2;
							exportWidth = baseDimension;
							exportHeight = baseDimension;
						} else if (aspectRatioValue > 1) {
							// Landscape: find largest even dimensions that exactly match aspect ratio
							const baseWidth = Math.floor(sourceWidth / 2) * 2;
							let found = false;
							for (let w = baseWidth; w >= 100 && !found; w -= 2) {
								const h = Math.round(w / aspectRatioValue);
								if (h % 2 === 0 && Math.abs(w / h - aspectRatioValue) < 0.0001) {
									exportWidth = w;
									exportHeight = h;
									found = true;
								}
							}
							if (!found) {
								exportWidth = baseWidth;
								exportHeight = Math.floor(baseWidth / aspectRatioValue / 2) * 2;
							}
						} else {
							// Portrait: find largest even dimensions that exactly match aspect ratio
							const baseHeight = Math.floor(sourceHeight / 2) * 2;
							let found = false;
							for (let h = baseHeight; h >= 100 && !found; h -= 2) {
								const w = Math.round(h * aspectRatioValue);
								if (w % 2 === 0 && Math.abs(w / h - aspectRatioValue) < 0.0001) {
									exportWidth = w;
									exportHeight = h;
									found = true;
								}
							}
							if (!found) {
								exportHeight = baseHeight;
								exportWidth = Math.floor((baseHeight * aspectRatioValue) / 2) * 2;
							}
						}

						// Calculate visually lossless bitrate matching screen recording optimization
						const totalPixels = exportWidth * exportHeight;
						bitrate = 30_000_000;
						if (totalPixels > 1920 * 1080 && totalPixels <= 2560 * 1440) {
							bitrate = 50_000_000;
						} else if (totalPixels > 2560 * 1440) {
							bitrate = 80_000_000;
						}
					} else {
						// Use quality-based target resolution
						const targetHeight = quality === "medium" ? 720 : 1080;

						// Calculate dimensions maintaining aspect ratio
						exportHeight = Math.floor(targetHeight / 2) * 2;
						exportWidth = Math.floor((exportHeight * aspectRatioValue) / 2) * 2;

						// Adjust bitrate for lower resolutions
						const totalPixels = exportWidth * exportHeight;
						if (totalPixels <= 1280 * 720) {
							bitrate = 10_000_000;
						} else if (totalPixels <= 1920 * 1080) {
							bitrate = 20_000_000;
						} else {
							bitrate = 30_000_000;
						}
					}

					const exporter = new VideoExporter({
						videoUrl: videoPath,
						webcamVideoUrl: webcamVideoPath || undefined,
						width: exportWidth,
						height: exportHeight,
						frameRate: 60,
						bitrate,
						codec: "avc1.640033",
						wallpaper,
						zoomRegions,
						trimRegions,
						speedRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						borderRadius,
						padding,
						cropRegion,
						annotationRegions,
						webcamLayoutPreset,
						webcamMaskShape,
						webcamBorderWidth,
						webcamBorderColor,
						webcamSizePreset,
						webcamPosition,
						webcamShadowPreset,
						webcamTrack: normalizedWebcamTrack,
						previewWidth,
						previewHeight,
						cursorTelemetry,
						onProgress: (progress: ExportProgress) => {
							setExportProgress(progress);
						},
					});

					exporterRef.current = exporter;
					const result = await exporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();
						const timestamp = Date.now();
						const fileName = `export-${timestamp}.mp4`;

						const saveResult = await window.electronAPI.saveExportedVideo(arrayBuffer, fileName);

						if (saveResult.canceled) {
							setUnsavedExport({ arrayBuffer, fileName, format: "mp4" });
							toast.info("Export canceled");
						} else if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							handleExportSaved("Video", saveResult.path);
						} else {
							setExportError(saveResult.message || "Failed to save video");
							toast.error(saveResult.message || "Failed to save video");
						}
					} else {
						setExportError(result.error || "Export failed");
						toast.error(result.error || "Export failed");
					}
				}

				if (wasPlaying) {
					videoPlaybackRef.current?.play();
				}
			} catch (error) {
				console.error("Export error:", error);
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				setExportError(errorMessage);
				toast.error(`Export failed: ${errorMessage}`);
			} finally {
				setIsExporting(false);
				exporterRef.current = null;
				// Reset dialog state to ensure it can be opened again on next export
				// This fixes the bug where second export doesn't show save dialog
				setShowExportDialog(false);
				setExportProgress(null);
			}
		},
		[
			videoPath,
			webcamVideoPath,
			wallpaper,
			zoomRegions,
			trimRegions,
			speedRegions,
			shadowIntensity,
			showBlur,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			annotationRegions,
			isPlaying,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamBorderWidth,
			webcamBorderColor,
			webcamSizePreset,
			webcamPosition,
			webcamShadowPreset,
			normalizedWebcamTrack,
			exportQuality,
			handleExportSaved,
			cursorTelemetry,
		],
	);

	const handleOpenExportDialog = useCallback(() => {
		if (!videoPath) {
			toast.error("No video loaded");
			return;
		}

		const video = videoPlaybackRef.current?.video;
		if (!video) {
			toast.error("Video not ready");
			return;
		}

		// Build export settings from current state
		const sourceWidth = video.videoWidth || 1920;
		const sourceHeight = video.videoHeight || 1080;
		const aspectRatioValue =
			aspectRatio === "native"
				? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
				: getAspectRatioValue(aspectRatio);
		const gifDimensions = calculateOutputDimensions(
			sourceWidth,
			sourceHeight,
			gifSizePreset,
			GIF_SIZE_PRESETS,
			aspectRatioValue,
		);

		const settings: ExportSettings = {
			format: exportFormat,
			quality: exportFormat === "mp4" ? exportQuality : undefined,
			gifConfig:
				exportFormat === "gif"
					? {
							frameRate: gifFrameRate,
							loop: gifLoop,
							sizePreset: gifSizePreset,
							width: gifDimensions.width,
							height: gifDimensions.height,
						}
					: undefined,
		};

		setShowExportDialog(true);
		setExportError(null);
		setExportedFilePath(null);

		// Start export immediately
		handleExport(settings);
	}, [
		videoPath,
		exportFormat,
		exportQuality,
		gifFrameRate,
		gifLoop,
		gifSizePreset,
		aspectRatio,
		cropRegion,
		handleExport,
	]);

	const handleCancelExport = useCallback(() => {
		if (exporterRef.current) {
			exporterRef.current.cancel();
			toast.info("Export canceled");
			setShowExportDialog(false);
			setIsExporting(false);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);
		}
	}, []);

	if (loading) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="text-foreground">Loading video...</div>
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="flex flex-col items-center gap-3">
					<div className="text-destructive">{error}</div>
					<button
						type="button"
						onClick={handleLoadProject}
						className="px-3 py-1.5 rounded-md bg-[#34B27B] text-white text-sm hover:bg-[#34B27B]/90"
					>
						Load Project File
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen bg-[#09090b] text-slate-200 overflow-hidden selection:bg-[#34B27B]/30">
			<Dialog open={showNewRecordingDialog} onOpenChange={setShowNewRecordingDialog}>
				<DialogContent
					className="sm:max-w-[425px]"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<DialogHeader>
						<DialogTitle>{t("newRecording.title")}</DialogTitle>
						<DialogDescription>{t("newRecording.description")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setShowNewRecordingDialog(false)}
							className="px-4 py-2 rounded-md bg-white/10 text-white hover:bg-white/20 text-sm font-medium transition-colors"
						>
							{t("newRecording.cancel")}
						</button>
						<button
							type="button"
							onClick={handleNewRecordingConfirm}
							className="px-4 py-2 rounded-md bg-[#34B27B] text-white hover:bg-[#34B27B]/90 text-sm font-medium transition-colors"
						>
							{t("newRecording.confirm")}
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<div
				className="h-10 flex-shrink-0 bg-[#09090b]/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between px-6 z-50"
				style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			>
				<div
					className="flex-1 flex items-center gap-1"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<div
						className={`flex items-center gap-1 px-2 py-1 rounded-md text-white/50 hover:text-white/90 hover:bg-white/10 transition-all duration-150 ${isMac ? "ml-14" : "ml-2"}`}
					>
						<Languages size={14} />
						<select
							value={locale}
							onChange={(e) => setLocale(e.target.value as Locale)}
							className="bg-transparent text-[11px] font-medium outline-none cursor-pointer appearance-none pr-1"
							style={{ color: "inherit" }}
						>
							{SUPPORTED_LOCALES.map((loc) => (
								<option key={loc} value={loc} className="bg-[#09090b] text-white">
									{getLocaleName(loc)}
								</option>
							))}
						</select>
					</div>
					<button
						type="button"
						onClick={() => setShowNewRecordingDialog(true)}
						className="flex items-center gap-1 px-2 py-1 rounded-md text-white/50 hover:text-white/90 hover:bg-white/10 transition-all duration-150 text-[11px] font-medium"
					>
						<Video size={14} />
						{t("newRecording.title")}
					</button>
					<button
						type="button"
						onClick={handleLoadProject}
						className="flex items-center gap-1 px-2 py-1 rounded-md text-white/50 hover:text-white/90 hover:bg-white/10 transition-all duration-150 text-[11px] font-medium"
					>
						<FolderOpen size={14} />
						{ts("project.load")}
					</button>
					<button
						type="button"
						onClick={handleSaveProject}
						className="flex items-center gap-1 px-2 py-1 rounded-md text-white/50 hover:text-white/90 hover:bg-white/10 transition-all duration-150 text-[11px] font-medium"
					>
						<Save size={14} />
						{ts("project.save")}
					</button>
				</div>
			</div>

			<div className="flex-1 p-5 gap-4 flex min-h-0 relative">
				{/* Left Column - Video & Timeline */}
				<div className="flex-[7] flex flex-col gap-3 min-w-0 h-full">
					<PanelGroup direction="vertical" className="gap-3">
						{/* Top section: video preview and controls */}
						<Panel defaultSize={70} maxSize={70} minSize={40}>
							<div
								ref={playerContainerRef}
								className={
									isFullscreen
										? "fixed inset-0 z-[99999] w-full h-full flex flex-col items-center justify-center bg-[#09090b]"
										: "w-full h-full flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-white/5 shadow-2xl overflow-hidden relative"
								}
							>
								{/* Video preview */}
								<div className="w-full flex justify-center items-center flex-auto mt-1.5">
									<div
										className="relative flex justify-center items-center w-auto h-full max-w-full box-border"
										style={{
											aspectRatio:
												aspectRatio === "native"
													? getNativeAspectRatioValue(
															videoPlaybackRef.current?.video?.videoWidth || 1920,
															videoPlaybackRef.current?.video?.videoHeight || 1080,
															cropRegion,
														)
													: getAspectRatioValue(aspectRatio),
										}}
									>
										<VideoPlayback
											key={`${videoPath || "no-video"}:${webcamVideoPath || "no-webcam"}`}
											aspectRatio={aspectRatio}
											ref={videoPlaybackRef}
											videoPath={videoPath || ""}
											webcamVideoPath={webcamVideoPath || undefined}
											webcamLayoutPreset={webcamLayoutPreset}
											webcamMaskShape={resolvedWebcamPresentation.maskShape}
											webcamBorderWidth={resolvedWebcamPresentation.borderWidth}
											webcamBorderColor={resolvedWebcamPresentation.borderColor}
											webcamSizePreset={resolvedWebcamPresentation.sizePreset}
											webcamPosition={resolvedWebcamPresentation.position}
											webcamShadowPreset={resolvedWebcamPresentation.shadowPreset}
											webcamVisible={resolvedWebcamPresentation.visible}
											webcamOpacity={resolvedWebcamPresentation.opacity}
											webcamScale={resolvedWebcamPresentation.scale}
											onResolvedWebcamPositionChange={setResolvedWebcamPosition}
											onWebcamPositionChange={(pos) =>
												upsertWebcamKeyframeAtCurrentTime({ position: pos }, "update")
											}
											onWebcamPositionDragEnd={commitState}
											onDurationChange={setDuration}
											onTimeUpdate={setCurrentTime}
											currentTime={currentTime}
											onPlayStateChange={setIsPlaying}
											onError={setError}
											wallpaper={wallpaper}
											zoomRegions={zoomRegions}
											selectedZoomId={selectedZoomId}
											onSelectZoom={handleSelectZoom}
											onZoomFocusChange={handleZoomFocusChange}
											onZoomFocusDragEnd={commitState}
											isPlaying={isPlaying}
											showShadow={shadowIntensity > 0}
											shadowIntensity={shadowIntensity}
											showBlur={showBlur}
											motionBlurAmount={motionBlurAmount}
											borderRadius={borderRadius}
											padding={padding}
											cropRegion={cropRegion}
											trimRegions={trimRegions}
											speedRegions={speedRegions}
											annotationRegions={annotationOnlyRegions}
											selectedAnnotationId={selectedAnnotationId}
											onSelectAnnotation={handleSelectAnnotation}
											onAnnotationPositionChange={handleAnnotationPositionChange}
											onAnnotationSizeChange={handleAnnotationSizeChange}
											blurRegions={blurRegions}
											selectedBlurId={selectedBlurId}
											onSelectBlur={handleSelectBlur}
											onBlurPositionChange={handleAnnotationPositionChange}
											onBlurSizeChange={handleAnnotationSizeChange}
											onBlurDataChange={handleBlurDataPreviewChange}
											onBlurDataCommit={commitState}
											cursorTelemetry={cursorTelemetry}
										/>
									</div>
								</div>
								{/* Playback controls */}
								<div className="w-full flex justify-center items-center h-12 flex-shrink-0 px-3 py-1.5 my-1.5">
									<div className="w-full max-w-[700px]">
										<PlaybackControls
											isPlaying={isPlaying}
											currentTime={currentTime}
											duration={duration}
											isFullscreen={isFullscreen}
											onToggleFullscreen={toggleFullscreen}
											onTogglePlayPause={togglePlayPause}
											onSeek={handleSeek}
										/>
									</div>
								</div>
							</div>
						</Panel>

						<PanelResizeHandle className="bg-[#09090b]/80 hover:bg-[#09090b] transition-colors rounded-full flex items-center justify-center">
							<div className="w-8 h-1 bg-white/20 rounded-full"></div>
						</PanelResizeHandle>

						{/* Timeline section */}
						<Panel defaultSize={30} maxSize={60} minSize={30}>
							<div className="h-full bg-[#09090b] rounded-2xl border border-white/5 shadow-lg overflow-hidden flex flex-col">
								<TimelineEditor
									videoDuration={duration}
									currentTime={currentTime}
									onSeek={handleSeek}
									cursorTelemetry={cursorTelemetry}
									zoomRegions={zoomRegions}
									onZoomAdded={handleZoomAdded}
									onZoomSuggested={handleZoomSuggested}
									onZoomSpanChange={handleZoomSpanChange}
									onZoomDelete={handleZoomDelete}
									selectedZoomId={selectedZoomId}
									onSelectZoom={handleSelectZoom}
									trimRegions={trimRegions}
									onTrimAdded={handleTrimAdded}
									onTrimSpanChange={handleTrimSpanChange}
									onTrimDelete={handleTrimDelete}
									selectedTrimId={selectedTrimId}
									onSelectTrim={handleSelectTrim}
									speedRegions={speedRegions}
									onSpeedAdded={handleSpeedAdded}
									onSpeedSpanChange={handleSpeedSpanChange}
									onSpeedDelete={handleSpeedDelete}
									selectedSpeedId={selectedSpeedId}
									onSelectSpeed={handleSelectSpeed}
									hasWebcam={Boolean(webcamVideoPath)}
									webcamSegments={normalizedWebcamTrack?.segments ?? []}
									webcamKeyframes={normalizedWebcamTrack?.keyframes ?? []}
									selectedWebcamSegmentId={selectedWebcamSegmentId}
									selectedWebcamKeyframeId={selectedWebcamKeyframeId}
									onWebcamAdded={handleAddWebcamSegment}
									onWebcamSpanChange={handleWebcamSegmentSpanChange}
									onWebcamDelete={handleWebcamSegmentDelete}
									onSelectWebcam={handleSelectWebcamSegment}
									onAddWebcamKeyframe={handleAddWebcamKeyframe}
									onWebcamKeyframeMove={handleWebcamKeyframeMove}
									onWebcamKeyframeMoveEnd={commitState}
									onSelectWebcamKeyframe={handleSelectWebcamKeyframe}
									onDeleteWebcamKeyframe={handleWebcamKeyframeDelete}
									hasMicrophoneTelemetry={microphoneTelemetry.length > 0}
									isMicrophoneTelemetryLoading={isMicrophoneTelemetryLoading}
									onGenerateWebcamVisibilityFromMic={() =>
										handleGenerateWebcamVisibilityFromMic(micAutomationConfig)
									}
									annotationRegions={annotationOnlyRegions}
									onAnnotationAdded={handleAnnotationAdded}
									onAnnotationSpanChange={handleAnnotationSpanChange}
									onAnnotationDelete={handleAnnotationDelete}
									selectedAnnotationId={selectedAnnotationId}
									onSelectAnnotation={handleSelectAnnotation}
									blurRegions={blurRegions}
									onBlurAdded={handleBlurAdded}
									onBlurSpanChange={handleAnnotationSpanChange}
									onBlurDelete={handleAnnotationDelete}
									selectedBlurId={selectedBlurId}
									onSelectBlur={handleSelectBlur}
									aspectRatio={aspectRatio}
									onAspectRatioChange={(ar) =>
										pushState({
											aspectRatio: ar,
											webcamLayoutPreset:
												!isPortraitAspectRatio(ar) && webcamLayoutPreset === "vertical-stack"
													? "picture-in-picture"
													: webcamLayoutPreset,
										})
									}
								/>
							</div>
						</Panel>
					</PanelGroup>
				</div>

				{/* Right section: settings panel */}
				<div className="flex-[3] min-w-[280px] max-w-[420px] h-full">
					<SettingsPanel
						selected={wallpaper}
						onWallpaperChange={(w) => pushState({ wallpaper: w })}
						selectedZoomDepth={
							selectedZoomId ? zoomRegions.find((z) => z.id === selectedZoomId)?.depth : null
						}
						onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
						selectedZoomFocusMode={
							selectedZoomId
								? (zoomRegions.find((z) => z.id === selectedZoomId)?.focusMode ?? "manual")
								: null
						}
						onZoomFocusModeChange={(mode) => selectedZoomId && handleZoomFocusModeChange(mode)}
						hasCursorTelemetry={cursorTelemetry.length > 0}
						selectedZoomId={selectedZoomId}
						onZoomDelete={handleZoomDelete}
						selectedTrimId={selectedTrimId}
						onTrimDelete={handleTrimDelete}
						shadowIntensity={shadowIntensity}
						onShadowChange={(v) => updateState({ shadowIntensity: v })}
						onShadowCommit={commitState}
						showBlur={showBlur}
						onBlurChange={(v) => pushState({ showBlur: v })}
						motionBlurAmount={motionBlurAmount}
						onMotionBlurChange={(v) => updateState({ motionBlurAmount: v })}
						onMotionBlurCommit={commitState}
						borderRadius={borderRadius}
						onBorderRadiusChange={(v) => updateState({ borderRadius: v })}
						onBorderRadiusCommit={commitState}
						padding={padding}
						onPaddingChange={(v) => updateState({ padding: v })}
						onPaddingCommit={commitState}
						cropRegion={cropRegion}
						onCropChange={(r) => pushState({ cropRegion: r })}
						aspectRatio={aspectRatio}
						hasWebcam={Boolean(webcamVideoPath)}
						webcamLayoutPreset={webcamLayoutPreset}
						onWebcamLayoutPresetChange={(preset) =>
							pushState({
								webcamLayoutPreset: preset,
								webcamPosition: preset === "vertical-stack" ? null : webcamPosition,
							})
						}
						webcamMaskShape={inspectedWebcamValues.maskShape}
						onWebcamMaskShapeChange={(shape) =>
							updateSelectedOrBaseWebcamKeyframe((values) => ({
								...values,
								maskShape: shape,
							}))
						}
						webcamBorderWidth={inspectedWebcamValues.borderWidth}
						onWebcamBorderWidthChange={(v) =>
							updateSelectedOrBaseWebcamKeyframe(
								(values) => ({
									...values,
									borderWidth: v,
								}),
								"update",
							)
						}
						onWebcamBorderWidthCommit={commitState}
						webcamBorderColor={inspectedWebcamValues.borderColor}
						onWebcamBorderColorChange={(value) =>
							updateSelectedOrBaseWebcamKeyframe((values) => ({
								...values,
								borderColor: value.toLowerCase(),
							}))
						}
						webcamSizePreset={inspectedWebcamValues.sizePreset}
						onWebcamSizePresetChange={(v) =>
							updateSelectedOrBaseWebcamKeyframe(
								(values) => ({
									...values,
									sizePreset: v,
								}),
								"update",
							)
						}
						onWebcamSizePresetCommit={commitState}
						webcamShadowPreset={inspectedWebcamValues.shadowPreset}
						onWebcamShadowPresetChange={(preset) =>
							updateSelectedOrBaseWebcamKeyframe((values) => ({
								...values,
								shadowPreset: preset,
							}))
						}
						webcamTrack={normalizedWebcamTrack}
						selectedWebcamSegmentId={selectedWebcamSegmentId}
						selectedWebcamKeyframeId={selectedWebcamKeyframeId}
						hasMicrophoneTelemetry={microphoneTelemetry.length > 0}
						isMicrophoneTelemetryLoading={isMicrophoneTelemetryLoading}
						micAutomationConfig={micAutomationConfig}
						onMicAutomationConfigChange={setMicAutomationConfig}
						onWebcamAnchorSelect={handleWebcamAnchorSelect}
						onWebcamEnterAnimationChange={(animation) =>
							pushState({
								webcamTrack: {
									...ensureWebcamTrackInitialized(webcamTrack, {
										explicitBasePosition:
											resolvedWebcamPosition ?? resolvedWebcamPresentation.position,
									}),
									enterAnimation: animation,
								},
							})
						}
						onWebcamExitAnimationChange={(animation) =>
							pushState({
								webcamTrack: {
									...ensureWebcamTrackInitialized(webcamTrack, {
										explicitBasePosition:
											resolvedWebcamPosition ?? resolvedWebcamPresentation.position,
									}),
									exitAnimation: animation,
								},
							})
						}
						videoElement={videoPlaybackRef.current?.video || null}
						exportQuality={exportQuality}
						onExportQualityChange={setExportQuality}
						exportFormat={exportFormat}
						onExportFormatChange={setExportFormat}
						gifFrameRate={gifFrameRate}
						onGifFrameRateChange={setGifFrameRate}
						gifLoop={gifLoop}
						onGifLoopChange={setGifLoop}
						gifSizePreset={gifSizePreset}
						onGifSizePresetChange={setGifSizePreset}
						gifOutputDimensions={calculateOutputDimensions(
							videoPlaybackRef.current?.video?.videoWidth || 1920,
							videoPlaybackRef.current?.video?.videoHeight || 1080,
							gifSizePreset,
							GIF_SIZE_PRESETS,
							aspectRatio === "native"
								? getNativeAspectRatioValue(
										videoPlaybackRef.current?.video?.videoWidth || 1920,
										videoPlaybackRef.current?.video?.videoHeight || 1080,
										cropRegion,
									)
								: getAspectRatioValue(aspectRatio),
						)}
						onExport={handleOpenExportDialog}
						selectedAnnotationId={selectedAnnotationId}
						annotationRegions={annotationOnlyRegions}
						onAnnotationContentChange={handleAnnotationContentChange}
						onAnnotationTypeChange={handleAnnotationTypeChange}
						onAnnotationStyleChange={handleAnnotationStyleChange}
						onAnnotationFigureDataChange={handleAnnotationFigureDataChange}
						onAnnotationDelete={handleAnnotationDelete}
						selectedBlurId={selectedBlurId}
						blurRegions={blurRegions}
						onBlurDataChange={handleBlurDataPanelChange}
						onBlurDataCommit={commitState}
						onBlurDelete={handleAnnotationDelete}
						selectedSpeedId={selectedSpeedId}
						selectedSpeedValue={
							selectedSpeedId
								? (speedRegions.find((r) => r.id === selectedSpeedId)?.speed ?? null)
								: null
						}
						onSpeedChange={handleSpeedChange}
						onSpeedDelete={handleSpeedDelete}
						unsavedExport={unsavedExport}
						onSaveUnsavedExport={handleSaveUnsavedExport}
					/>
				</div>
			</div>

			<ExportDialog
				isOpen={showExportDialog}
				onClose={() => setShowExportDialog(false)}
				progress={exportProgress}
				isExporting={isExporting}
				error={exportError}
				onCancel={handleCancelExport}
				exportFormat={exportFormat}
				exportedFilePath={exportedFilePath || undefined}
				onShowInFolder={
					exportedFilePath ? () => void handleShowExportedFile(exportedFilePath) : undefined
				}
			/>
		</div>
	);
}
