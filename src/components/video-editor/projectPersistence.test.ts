import { describe, expect, it } from "vitest";
import {
	createProjectData,
	createProjectSnapshot,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	PROJECT_VERSION,
	resolveProjectMedia,
	validateProjectData,
} from "./projectPersistence";

describe("projectPersistence media compatibility", () => {
	it("accepts legacy projects with a single videoPath", () => {
		const project = {
			version: 1,
			videoPath: "/tmp/screen.webm",
			editor: {},
		};

		expect(validateProjectData(project)).toBe(true);
		expect(resolveProjectMedia(project)).toEqual({
			screenVideoPath: "/tmp/screen.webm",
		});
	});

	it("creates version 3 projects with explicit media", () => {
		const project = createProjectData(
			{
				screenVideoPath: "/tmp/screen.webm",
				webcamVideoPath: "/tmp/webcam.webm",
			},
			{
				wallpaper: "/wallpapers/wallpaper1.jpg",
				shadowIntensity: 0,
				showBlur: false,
				motionBlurAmount: 0,
				borderRadius: 0,
				padding: 50,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				zoomRegions: [],
				trimRegions: [],
				speedRegions: [],
				annotationRegions: [],
				aspectRatio: "16:9",
				webcamLayoutPreset: "picture-in-picture",
				webcamMaskShape: "circle",
				webcamBorderWidth: 4,
				webcamBorderColor: "#22c55e",
				webcamSizePreset: 25,
				webcamPosition: null,
				webcamShadowPreset: "soft",
				webcamTrack: null,
				exportQuality: "good",
				exportFormat: "mp4",
				gifFrameRate: 15,
				gifLoop: true,
				gifSizePreset: "medium",
			},
		);

		expect(project.version).toBe(PROJECT_VERSION);
		expect(project.media).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
		expect(validateProjectData(project)).toBe(true);
	});

	it("normalizes webcam mask shape values safely", () => {
		expect(normalizeProjectEditor({ webcamMaskShape: "rounded" }).webcamMaskShape).toBe("rounded");
		expect(
			normalizeProjectEditor({ webcamMaskShape: "not-a-real-shape" as never }).webcamMaskShape,
		).toBe("rectangle");
	});

	it("clamps webcam border settings safely", () => {
		const normalized = normalizeProjectEditor({
			webcamBorderWidth: 42,
			webcamBorderColor: "not-a-color",
		});

		expect(normalized.webcamBorderWidth).toBe(10);
		expect(normalized.webcamBorderColor).toBe("#ffffff");
	});
});

it("creates stable snapshots for identical project state", () => {
	const media = {
		screenVideoPath: "/tmp/screen.webm",
		webcamVideoPath: "/tmp/webcam.webm",
	};
	const editor = normalizeProjectEditor({
		wallpaper: "/wallpapers/wallpaper1.jpg",
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 50,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		annotationRegions: [],
		aspectRatio: "16:9",
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "circle",
		webcamBorderWidth: 2,
		webcamBorderColor: "#ffffff",
		webcamSizePreset: 25,
		webcamPosition: null,
		webcamShadowPreset: "soft",
		webcamTrack: {
			segments: [{ id: "segment-1", startMs: 0, endMs: 2_000 }],
			keyframes: [
				{
					id: "keyframe-1",
					timeMs: 0,
					values: {
						position: { cx: 0.75, cy: 0.75 },
						sizePreset: 25,
						borderWidth: 2,
						borderColor: "#ffffff",
						maskShape: "circle",
						shadowPreset: "soft",
					},
				},
			],
			enterAnimation: "scale+fade",
			exitAnimation: "fade",
		},
		exportQuality: "good",
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
	});

	expect(createProjectSnapshot(media, editor)).toBe(createProjectSnapshot(media, editor));
});

it("normalizes webcam track and shadow preset safely", () => {
	const normalized = normalizeProjectEditor({
		webcamShadowPreset: "strong",
		webcamTrack: {
			segments: [{ id: "segment-1", startMs: 500, endMs: 100 }],
			keyframes: [
				{
					id: "keyframe-1",
					timeMs: -50,
					values: {
						position: { cx: 3, cy: -1 },
						sizePreset: 100,
						borderWidth: 99,
						borderColor: "oops",
						maskShape: "circle",
						shadowPreset: "strong",
					},
				},
			],
			enterAnimation: "fade",
			exitAnimation: "none",
		},
	});

	expect(normalized.webcamShadowPreset).toBe("strong");
	expect(normalized.webcamTrack).toEqual({
		segments: [{ id: "segment-1", startMs: 500, endMs: 501 }],
		keyframes: [
			{
				id: "keyframe-1",
				timeMs: 0,
				values: {
					position: { cx: 1, cy: 0 },
					sizePreset: 50,
					borderWidth: 10,
					borderColor: "#ffffff",
					maskShape: "circle",
					shadowPreset: "strong",
				},
			},
		],
		enterAnimation: "fade",
		exitAnimation: "none",
	});
});

it("detects unsaved changes from differing snapshots", () => {
	expect(hasProjectUnsavedChanges(null, null)).toBe(false);
	expect(hasProjectUnsavedChanges("same", "same")).toBe(false);
	expect(hasProjectUnsavedChanges("current", "baseline")).toBe(true);
});
