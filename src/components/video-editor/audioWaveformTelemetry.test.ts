import { describe, expect, it } from "vitest";
import {
	AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS,
	buildMicrophoneTelemetryFromAudioBuffer,
	buildMicrophoneTelemetryFromChannelData,
} from "./audioWaveformTelemetry";

describe("buildMicrophoneTelemetryFromChannelData", () => {
	it("samples audio windows into timeline-friendly telemetry points", () => {
		const telemetry = buildMicrophoneTelemetryFromChannelData(
			[new Float32Array([0, 0, 0.4, 0.4, 0.8, 0.8])],
			10,
			200,
		);

		expect(telemetry).toEqual([
			{ timeMs: 0, level: 0 },
			{ timeMs: 200, level: 96 },
			{ timeMs: 400, level: 100 },
		]);
	});

	it("averages across multiple channels", () => {
		const telemetry = buildMicrophoneTelemetryFromChannelData(
			[new Float32Array([0.5, 0.5, 0, 0]), new Float32Array([0.5, 0.5, 0.5, 0.5])],
			10,
			200,
		);

		expect(telemetry).toHaveLength(2);
		expect(telemetry[0].level).toBeGreaterThan(telemetry[1].level);
	});
});

describe("buildMicrophoneTelemetryFromAudioBuffer", () => {
	it("reads channel data from an audio buffer-like object", () => {
		const channels = [new Float32Array([0, 0.25, 0.5, 0.75])];
		const telemetry = buildMicrophoneTelemetryFromAudioBuffer(
			{
				numberOfChannels: 1,
				sampleRate: 10,
				getChannelData: (index: number) => channels[index],
			},
			AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS * 2,
		);

		expect(telemetry[0].timeMs).toBe(0);
		expect(telemetry[0].level).toBeGreaterThan(0);
	});
});
