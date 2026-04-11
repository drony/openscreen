import {
	DEFAULT_WEBCAM_BORDER_COLOR,
	DEFAULT_WEBCAM_BORDER_WIDTH,
	DEFAULT_WEBCAM_MASK_SHAPE,
	DEFAULT_WEBCAM_POSITION,
	DEFAULT_WEBCAM_SHADOW_PRESET,
	DEFAULT_WEBCAM_SIZE_PRESET,
	DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
	MAX_WEBCAM_BORDER_WIDTH,
	type MicrophoneTelemetryPoint,
	type WebcamAutomationValues,
	type WebcamKeyframe,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSegment,
	type WebcamShadowPreset,
	type WebcamTrack,
	type WebcamVisibilityAnimation,
} from "./types";

const MIN_WEBCAM_SIZE_PRESET = 10;
const MAX_WEBCAM_SIZE_PRESET = 50;
export const WEBCAM_VISIBILITY_ANIMATION_DURATION_MS = 240;

export interface WebcamPresentationBase {
	position: WebcamPosition | null;
	sizePreset: number;
	borderWidth: number;
	borderColor: string;
	maskShape: WebcamMaskShape;
	shadowPreset: WebcamShadowPreset;
}

export interface ResolvedWebcamPresentation extends WebcamPresentationBase {
	visible: boolean;
	opacity: number;
	scale: number;
	enterAnimation: WebcamVisibilityAnimation;
	exitAnimation: WebcamVisibilityAnimation;
}

export interface WebcamShadowStyle {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

export interface GenerateWebcamSegmentsFromMicConfig {
	threshold: number;
	attackMs: number;
	holdMs: number;
	releaseMs: number;
	minimumVisibleDurationMs: number;
}

export const DEFAULT_MICROPHONE_VISIBILITY_CONFIG: GenerateWebcamSegmentsFromMicConfig = {
	threshold: 28,
	attackMs: 180,
	holdMs: 280,
	releaseMs: 180,
	minimumVisibleDurationMs: 400,
};

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function clampSizePresetValue(value: number) {
	return clamp(value, MIN_WEBCAM_SIZE_PRESET, MAX_WEBCAM_SIZE_PRESET);
}

function normalizeSizePreset(value: number) {
	return Math.round(clampSizePresetValue(value));
}

function clampBorderWidthValue(value: number) {
	return clamp(value, 0, MAX_WEBCAM_BORDER_WIDTH);
}

function normalizeBorderWidth(value: number) {
	return Math.round(clampBorderWidthValue(value));
}

function isValidHexColor(value: string) {
	return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function normalizeColor(value: string) {
	return isValidHexColor(value) ? value.trim().toLowerCase() : DEFAULT_WEBCAM_BORDER_COLOR;
}

function normalizePosition(position: WebcamPosition | null): WebcamPosition | null {
	if (!position) {
		return DEFAULT_WEBCAM_POSITION;
	}

	return {
		cx: clamp(position.cx, 0, 1),
		cy: clamp(position.cy, 0, 1),
	};
}

export function createWebcamAutomationValues(
	values: Partial<WebcamAutomationValues> = {},
): WebcamAutomationValues {
	return {
		position: normalizePosition(values.position ?? DEFAULT_WEBCAM_POSITION),
		sizePreset: normalizeSizePreset(values.sizePreset ?? DEFAULT_WEBCAM_SIZE_PRESET),
		borderWidth: normalizeBorderWidth(values.borderWidth ?? DEFAULT_WEBCAM_BORDER_WIDTH),
		borderColor: normalizeColor(values.borderColor ?? DEFAULT_WEBCAM_BORDER_COLOR),
		maskShape: values.maskShape ?? DEFAULT_WEBCAM_MASK_SHAPE,
		shadowPreset: values.shadowPreset ?? DEFAULT_WEBCAM_SHADOW_PRESET,
	};
}

export function normalizeWebcamTrack(track: WebcamTrack | null | undefined): WebcamTrack | null {
	if (!track || typeof track !== "object") {
		return null;
	}

	const segments: WebcamSegment[] = Array.isArray(track.segments)
		? track.segments
				.filter((segment): segment is WebcamSegment =>
					Boolean(segment && typeof segment.id === "string"),
				)
				.map((segment) => {
					const startMs = Math.max(
						0,
						Number.isFinite(segment.startMs) ? Math.round(segment.startMs) : 0,
					);
					const rawEnd = Number.isFinite(segment.endMs)
						? Math.round(segment.endMs)
						: startMs + 1_000;
					return {
						id: segment.id,
						startMs,
						endMs: Math.max(startMs + 1, rawEnd),
					};
				})
				.sort((a, b) => a.startMs - b.startMs)
		: [];

	const keyframes: WebcamKeyframe[] = Array.isArray(track.keyframes)
		? track.keyframes
				.filter((keyframe): keyframe is WebcamKeyframe =>
					Boolean(keyframe && typeof keyframe.id === "string"),
				)
				.map((keyframe) => ({
					id: keyframe.id,
					timeMs: Math.max(0, Number.isFinite(keyframe.timeMs) ? Math.round(keyframe.timeMs) : 0),
					values: createWebcamAutomationValues(keyframe.values),
				}))
				.sort((a, b) => a.timeMs - b.timeMs)
		: [];

	return {
		segments,
		keyframes,
		enterAnimation:
			track.enterAnimation === "none" ||
			track.enterAnimation === "fade" ||
			track.enterAnimation === "scale+fade"
				? track.enterAnimation
				: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
		exitAnimation:
			track.exitAnimation === "none" ||
			track.exitAnimation === "fade" ||
			track.exitAnimation === "scale+fade"
				? track.exitAnimation
				: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
	};
}

function easeInOutMotion(progress: number) {
	const clamped = clamp(progress, 0, 1);
	return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function easeOutCubic(progress: number) {
	return 1 - Math.pow(1 - clamp(progress, 0, 1), 3);
}

function interpolateNumeric(start: number, end: number, progress: number) {
	return start + (end - start) * easeInOutMotion(progress);
}

function interpolatePosition(
	start: WebcamPosition | null,
	end: WebcamPosition | null,
	progress: number,
): WebcamPosition | null {
	if (!start && !end) {
		return null;
	}

	if (!start || !end) {
		return progress < 0.5 ? start : end;
	}

	return {
		cx: interpolateNumeric(start.cx, end.cx, progress),
		cy: interpolateNumeric(start.cy, end.cy, progress),
	};
}

function resolveInterpolatedValues(
	base: WebcamAutomationValues,
	track: WebcamTrack,
	timeMs: number,
): WebcamAutomationValues {
	if (track.keyframes.length === 0) {
		return base;
	}

	const previous =
		[...track.keyframes].reverse().find((keyframe) => keyframe.timeMs <= timeMs) ?? null;
	const next = track.keyframes.find((keyframe) => keyframe.timeMs > timeMs) ?? null;

	const startValues = previous?.values ?? base;
	const endValues = next?.values ?? startValues;
	const duration = previous && next ? Math.max(1, next.timeMs - previous.timeMs) : 1;
	const progress = previous && next ? clamp((timeMs - previous.timeMs) / duration, 0, 1) : 0;

	return {
		position: interpolatePosition(startValues.position, endValues.position, progress),
		sizePreset: clampSizePresetValue(
			interpolateNumeric(startValues.sizePreset, endValues.sizePreset, progress),
		),
		borderWidth: clampBorderWidthValue(
			interpolateNumeric(startValues.borderWidth, endValues.borderWidth, progress),
		),
		borderColor: progress < 1 ? startValues.borderColor : endValues.borderColor,
		maskShape: progress < 1 ? startValues.maskShape : endValues.maskShape,
		shadowPreset: progress < 1 ? startValues.shadowPreset : endValues.shadowPreset,
	};
}

function getAnimationProgress(
	animation: WebcamVisibilityAnimation,
	progress: number,
): { opacity: number; scale: number } {
	const clamped = clamp(progress, 0, 1);
	const eased = easeOutCubic(clamped);
	if (animation === "none") {
		return { opacity: 1, scale: 1 };
	}
	if (animation === "fade") {
		return { opacity: eased, scale: 1 };
	}
	return {
		opacity: eased,
		scale: 0.82 + eased * 0.18,
	};
}

export function resolveWebcamPresentation(
	timeMs: number,
	baseState: WebcamPresentationBase,
	webcamTrack: WebcamTrack | null | undefined,
): ResolvedWebcamPresentation {
	const base = createWebcamAutomationValues(baseState);
	const normalizedTrack = normalizeWebcamTrack(webcamTrack);

	if (!normalizedTrack) {
		return {
			...base,
			visible: true,
			opacity: 1,
			scale: 1,
			enterAnimation: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
			exitAnimation: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
		};
	}

	const activeSegment =
		normalizedTrack.segments.find(
			(segment) => timeMs >= segment.startMs && timeMs <= segment.endMs,
		) ?? null;
	const values = resolveInterpolatedValues(base, normalizedTrack, timeMs);

	if (!activeSegment) {
		return {
			...values,
			visible: false,
			opacity: 0,
			scale: 0,
			enterAnimation: normalizedTrack.enterAnimation,
			exitAnimation: normalizedTrack.exitAnimation,
		};
	}

	const duration = WEBCAM_VISIBILITY_ANIMATION_DURATION_MS;
	const intro =
		timeMs <= activeSegment.startMs + duration
			? getAnimationProgress(
					normalizedTrack.enterAnimation,
					(timeMs - activeSegment.startMs) / duration,
				)
			: { opacity: 1, scale: 1 };
	const outro =
		timeMs >= activeSegment.endMs - duration
			? getAnimationProgress(
					normalizedTrack.exitAnimation,
					(activeSegment.endMs - timeMs) / duration,
				)
			: { opacity: 1, scale: 1 };

	return {
		...values,
		visible: true,
		opacity: Math.min(intro.opacity, outro.opacity),
		scale: Math.min(intro.scale, outro.scale),
		enterAnimation: normalizedTrack.enterAnimation,
		exitAnimation: normalizedTrack.exitAnimation,
	};
}

export function getWebcamShadowStyle(preset: WebcamShadowPreset): WebcamShadowStyle | null {
	switch (preset) {
		case "off":
			return null;
		case "strong":
			return {
				color: "rgba(0,0,0,0.42)",
				blur: 32,
				offsetX: 0,
				offsetY: 14,
			};
		case "soft":
		default:
			return {
				color: "rgba(0,0,0,0.30)",
				blur: 20,
				offsetX: 0,
				offsetY: 8,
			};
	}
}

export function getWebcamShadowCssBoxShadow(preset: WebcamShadowPreset): string {
	const shadow = getWebcamShadowStyle(preset);
	return shadow
		? `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color}`
		: "none";
}

export function createDefaultWebcamTrack(
	durationMs: number,
	baseState: WebcamPresentationBase,
	createId: (prefix: "segment" | "keyframe") => string,
): WebcamTrack {
	return {
		segments: [
			{
				id: createId("segment"),
				startMs: 0,
				endMs: Math.max(1, Math.round(durationMs)),
			},
		],
		keyframes: [
			{
				id: createId("keyframe"),
				timeMs: 0,
				values: createWebcamAutomationValues(baseState),
			},
		],
		enterAnimation: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
		exitAnimation: DEFAULT_WEBCAM_VISIBILITY_ANIMATION,
	};
}

export function generateWebcamSegmentsFromMicrophoneTelemetry(
	samples: MicrophoneTelemetryPoint[],
	durationMs: number,
	config: GenerateWebcamSegmentsFromMicConfig,
	createId: () => string,
): WebcamSegment[] {
	if (samples.length === 0 || durationMs <= 0) {
		return [];
	}

	const sortedSamples = [...samples]
		.filter((sample) => Number.isFinite(sample.timeMs) && Number.isFinite(sample.level))
		.sort((a, b) => a.timeMs - b.timeMs);

	const threshold = clamp(config.threshold, 0, 100);
	const attackMs = Math.max(0, config.attackMs);
	const holdMs = Math.max(0, config.holdMs);
	const releaseMs = Math.max(0, config.releaseMs);
	const minimumVisibleDurationMs = Math.max(1, config.minimumVisibleDurationMs);

	const rawSegments: Array<{ startMs: number; endMs: number }> = [];
	let runStart: number | null = null;
	let lastAboveTime: number | null = null;

	for (const sample of sortedSamples) {
		const timeMs = clamp(Math.round(sample.timeMs), 0, durationMs);
		if (sample.level >= threshold) {
			if (runStart === null) {
				runStart = timeMs;
			}
			lastAboveTime = timeMs;
			continue;
		}

		if (runStart !== null && lastAboveTime !== null) {
			if (lastAboveTime - runStart >= attackMs) {
				rawSegments.push({
					startMs: runStart,
					endMs: clamp(lastAboveTime + holdMs, runStart + 1, durationMs),
				});
			}
		}

		runStart = null;
		lastAboveTime = null;
	}

	if (runStart !== null && lastAboveTime !== null && lastAboveTime - runStart >= attackMs) {
		rawSegments.push({
			startMs: runStart,
			endMs: clamp(lastAboveTime + holdMs, runStart + 1, durationMs),
		});
	}

	if (rawSegments.length === 0) {
		return [];
	}

	const merged: Array<{ startMs: number; endMs: number }> = [];
	for (const segment of rawSegments) {
		const previous = merged[merged.length - 1];
		if (!previous) {
			merged.push(segment);
			continue;
		}

		if (segment.startMs - previous.endMs <= releaseMs) {
			previous.endMs = Math.max(previous.endMs, segment.endMs);
			continue;
		}

		merged.push(segment);
	}

	return merged.map((segment) => {
		const duration = segment.endMs - segment.startMs;
		return {
			id: createId(),
			startMs: segment.startMs,
			endMs:
				duration >= minimumVisibleDurationMs
					? segment.endMs
					: clamp(segment.startMs + minimumVisibleDurationMs, segment.startMs + 1, durationMs),
		};
	});
}
