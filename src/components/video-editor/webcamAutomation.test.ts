import { describe, expect, it } from "vitest";
import {
	createDefaultWebcamTrack,
	generateWebcamSegmentsFromMicrophoneTelemetry,
	resolveWebcamPresentation,
} from "./webcamAutomation";

describe("resolveWebcamPresentation", () => {
	it("falls back to base webcam state when no track exists", () => {
		const presentation = resolveWebcamPresentation(
			500,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 25,
				borderWidth: 2,
				borderColor: "#ffffff",
				maskShape: "circle",
				shadowPreset: "soft",
			},
			null,
		);

		expect(presentation.visible).toBe(true);
		expect(presentation.position).toEqual({ cx: 0.8, cy: 0.8 });
		expect(presentation.opacity).toBe(1);
		expect(presentation.scale).toBe(1);
	});

	it("interpolates numeric values and steps color and shape", () => {
		const track = createDefaultWebcamTrack(
			2_000,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 20,
				borderWidth: 0,
				borderColor: "#ffffff",
				maskShape: "rectangle",
				shadowPreset: "soft",
			},
			(prefix) => `${prefix}-1`,
		);
		track.keyframes.push({
			id: "keyframe-2",
			timeMs: 1_000,
			values: {
				position: { cx: 0.2, cy: 0.2 },
				sizePreset: 40,
				borderWidth: 8,
				borderColor: "#22c55e",
				maskShape: "circle",
				shadowPreset: "strong",
			},
		});

		const mid = resolveWebcamPresentation(
			500,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 20,
				borderWidth: 0,
				borderColor: "#ffffff",
				maskShape: "rectangle",
				shadowPreset: "soft",
			},
			track,
		);

		expect(mid.position?.cx).toBeCloseTo(0.5, 2);
		expect(mid.position?.cy).toBeCloseTo(0.5, 2);
		expect(mid.sizePreset).toBe(30);
		expect(mid.borderWidth).toBe(4);
		expect(mid.borderColor).toBe("#ffffff");
		expect(mid.maskShape).toBe("rectangle");
		expect(mid.shadowPreset).toBe("soft");
	});

	it("applies enter and exit visibility animations", () => {
		const track = createDefaultWebcamTrack(
			2_000,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 25,
				borderWidth: 2,
				borderColor: "#ffffff",
				maskShape: "circle",
				shadowPreset: "soft",
			},
			(prefix) => `${prefix}-1`,
		);
		track.segments = [{ id: "segment-1", startMs: 1_000, endMs: 1_600 }];

		const intro = resolveWebcamPresentation(
			1_050,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 25,
				borderWidth: 2,
				borderColor: "#ffffff",
				maskShape: "circle",
				shadowPreset: "soft",
			},
			track,
		);
		const outro = resolveWebcamPresentation(
			1_560,
			{
				position: { cx: 0.8, cy: 0.8 },
				sizePreset: 25,
				borderWidth: 2,
				borderColor: "#ffffff",
				maskShape: "circle",
				shadowPreset: "soft",
			},
			track,
		);

		expect(intro.visible).toBe(true);
		expect(intro.opacity).toBeGreaterThan(0);
		expect(intro.opacity).toBeLessThan(1);
		expect(intro.scale).toBeLessThan(1);
		expect(outro.opacity).toBeLessThan(1);
	});
});

describe("generateWebcamSegmentsFromMicrophoneTelemetry", () => {
	it("creates merged webcam segments from mic telemetry", () => {
		const segments = generateWebcamSegmentsFromMicrophoneTelemetry(
			[
				{ timeMs: 0, level: 10 },
				{ timeMs: 100, level: 42 },
				{ timeMs: 200, level: 48 },
				{ timeMs: 300, level: 18 },
				{ timeMs: 360, level: 44 },
				{ timeMs: 520, level: 40 },
				{ timeMs: 700, level: 12 },
			],
			2_000,
			{
				threshold: 30,
				attackMs: 80,
				holdMs: 120,
				releaseMs: 120,
				minimumVisibleDurationMs: 250,
			},
			() => "segment-id",
		);

		expect(segments).toHaveLength(1);
		expect(segments[0].startMs).toBe(100);
		expect(segments[0].endMs).toBeGreaterThanOrEqual(620);
	});

	it("filters out spikes shorter than the minimum visible duration", () => {
		const segments = generateWebcamSegmentsFromMicrophoneTelemetry(
			[
				{ timeMs: 0, level: 12 },
				{ timeMs: 100, level: 60 },
				{ timeMs: 120, level: 10 },
				{ timeMs: 400, level: 10 },
			],
			1_000,
			{
				threshold: 30,
				attackMs: 80,
				holdMs: 50,
				releaseMs: 20,
				minimumVisibleDurationMs: 300,
			},
			() => "segment-id",
		);

		expect(segments).toHaveLength(0);
	});
});
