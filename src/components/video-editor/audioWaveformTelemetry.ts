import { WebDemuxer } from "web-demuxer";
import type { MicrophoneTelemetryPoint } from "./types";

export const AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS = 100;
const MICROPHONE_LEVEL_SCALE = 240;
const SOURCE_LOAD_TIMEOUT_MS = 60_000;
const DECODE_BACKPRESSURE_LIMIT = 20;

type SupportedAudioFormat =
	| "u8"
	| "s16"
	| "s32"
	| "f32"
	| "u8-planar"
	| "s16-planar"
	| "s32-planar"
	| "f32-planar";

type SampleBuffer = Float32Array | Int32Array | Int16Array | Uint8Array;

interface TelemetryAccumulator {
	windowStartFrame: number;
	processedFrames: number;
	windowSumSquares: number;
	windowSampleCount: number;
	samples: MicrophoneTelemetryPoint[];
}

function isRemoteUrl(value: string) {
	return /^(https?:|blob:|data:)/i.test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				window.clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function loadAudioSourceFile(sourcePath: string): Promise<File> {
	if (!isRemoteUrl(sourcePath) && window.electronAPI?.readBinaryFile) {
		const result = await withTimeout(
			window.electronAPI.readBinaryFile(sourcePath),
			SOURCE_LOAD_TIMEOUT_MS,
			"Timed out while loading the source recording.",
		);
		if (!result.success || !result.data) {
			throw new Error(result.message || result.error || "Failed to read source audio");
		}

		const filename = (result.path || sourcePath).split(/[\\/]/).pop() || "recording";
		const blob = new Blob([result.data]);
		return new File([blob], filename, { type: blob.type || "application/octet-stream" });
	}

	const response = await withTimeout(
		fetch(sourcePath),
		SOURCE_LOAD_TIMEOUT_MS,
		"Timed out while loading the source recording.",
	);
	if (!response.ok) {
		throw new Error(`Failed to fetch source audio: ${response.status} ${response.statusText}`);
	}

	const blob = await withTimeout(
		response.blob(),
		SOURCE_LOAD_TIMEOUT_MS,
		"Timed out while reading the source recording.",
	);
	const filename = sourcePath.split("/").pop() || "recording";
	return new File([blob], filename, { type: blob.type || "application/octet-stream" });
}

function getBaseAudioFormat(format: SupportedAudioFormat): "u8" | "s16" | "s32" | "f32" {
	if (format.startsWith("u8")) return "u8";
	if (format.startsWith("s16")) return "s16";
	if (format.startsWith("s32")) return "s32";
	return "f32";
}

function isPlanarFormat(format: SupportedAudioFormat) {
	return format.endsWith("-planar");
}

function createSampleBuffer(format: SupportedAudioFormat, sampleCount: number): SampleBuffer {
	switch (getBaseAudioFormat(format)) {
		case "u8":
			return new Uint8Array(sampleCount);
		case "s16":
			return new Int16Array(sampleCount);
		case "s32":
			return new Int32Array(sampleCount);
		case "f32":
		default:
			return new Float32Array(sampleCount);
	}
}

function normalizeAudioSample(value: number, format: SupportedAudioFormat) {
	switch (getBaseAudioFormat(format)) {
		case "u8":
			return (value - 128) / 128;
		case "s16":
			return value / 32768;
		case "s32":
			return value / 2147483648;
		case "f32":
		default:
			return value;
	}
}

function flushTelemetryWindow(accumulator: TelemetryAccumulator, sampleRate: number) {
	if (accumulator.windowSampleCount === 0 || sampleRate <= 0) {
		return;
	}

	const rms = Math.sqrt(accumulator.windowSumSquares / accumulator.windowSampleCount);
	const level = Math.min(100, rms * MICROPHONE_LEVEL_SCALE);

	accumulator.samples.push({
		timeMs: Math.round((accumulator.windowStartFrame / sampleRate) * 1000),
		level: Number(level.toFixed(2)),
	});

	accumulator.windowStartFrame = accumulator.processedFrames;
	accumulator.windowSumSquares = 0;
	accumulator.windowSampleCount = 0;
}

function appendAudioFrameWindow(
	accumulator: TelemetryAccumulator,
	frameSumSquares: number,
	channelCount: number,
	sampleRate: number,
	windowSizeFrames: number,
) {
	accumulator.windowSumSquares += frameSumSquares;
	accumulator.windowSampleCount += channelCount;
	accumulator.processedFrames += 1;

	if (accumulator.processedFrames - accumulator.windowStartFrame >= windowSizeFrames) {
		flushTelemetryWindow(accumulator, sampleRate);
	}
}

function accumulateAudioData(
	audioData: AudioData,
	accumulator: TelemetryAccumulator,
	windowSizeFrames: number,
	sampleRate: number,
) {
	const format = audioData.format as SupportedAudioFormat;
	const frameCount = audioData.numberOfFrames;
	const channelCount = audioData.numberOfChannels;

	if (frameCount <= 0 || channelCount <= 0) {
		return;
	}

	if (isPlanarFormat(format)) {
		const channelPlanes = Array.from({ length: channelCount }, (_, channelIndex) => {
			const buffer = createSampleBuffer(format, frameCount);
			audioData.copyTo(buffer, { planeIndex: channelIndex });
			return buffer;
		});

		for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
			let frameSumSquares = 0;
			for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
				const sample = normalizeAudioSample(channelPlanes[channelIndex][frameIndex] ?? 0, format);
				frameSumSquares += sample * sample;
			}
			appendAudioFrameWindow(
				accumulator,
				frameSumSquares,
				channelCount,
				sampleRate,
				windowSizeFrames,
			);
		}
		return;
	}

	const interleaved = createSampleBuffer(format, frameCount * channelCount);
	audioData.copyTo(interleaved, { planeIndex: 0 });

	for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
		let frameSumSquares = 0;
		const frameOffset = frameIndex * channelCount;
		for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
			const sample = normalizeAudioSample(interleaved[frameOffset + channelIndex] ?? 0, format);
			frameSumSquares += sample * sample;
		}
		appendAudioFrameWindow(
			accumulator,
			frameSumSquares,
			channelCount,
			sampleRate,
			windowSizeFrames,
		);
	}
}

export function buildMicrophoneTelemetryFromChannelData(
	channels: readonly Float32Array[],
	sampleRate: number,
	sampleIntervalMs: number = AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS,
): MicrophoneTelemetryPoint[] {
	if (channels.length === 0 || sampleRate <= 0 || sampleIntervalMs <= 0) {
		return [];
	}

	const windowSize = Math.max(1, Math.round((sampleRate * sampleIntervalMs) / 1000));
	const maxLength = Math.max(...channels.map((channel) => channel.length));
	const samples: MicrophoneTelemetryPoint[] = [];

	for (let start = 0; start < maxLength; start += windowSize) {
		let sum = 0;
		let count = 0;

		for (const channel of channels) {
			const end = Math.min(start + windowSize, channel.length);
			for (let index = start; index < end; index += 1) {
				const value = channel[index] ?? 0;
				sum += value * value;
				count += 1;
			}
		}

		if (count === 0) {
			continue;
		}

		const rms = Math.sqrt(sum / count);
		const level = Math.min(100, rms * MICROPHONE_LEVEL_SCALE);

		samples.push({
			timeMs: Math.round((start / sampleRate) * 1000),
			level: Number(level.toFixed(2)),
		});
	}

	return samples;
}

export function buildMicrophoneTelemetryFromAudioBuffer(
	audioBuffer: Pick<AudioBuffer, "numberOfChannels" | "sampleRate" | "getChannelData">,
	sampleIntervalMs: number = AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS,
): MicrophoneTelemetryPoint[] {
	const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) =>
		audioBuffer.getChannelData(index),
	);
	return buildMicrophoneTelemetryFromChannelData(
		channels,
		audioBuffer.sampleRate,
		sampleIntervalMs,
	);
}

export async function buildMicrophoneTelemetryFromSource(
	sourcePath: string,
	sampleIntervalMs: number = AUDIO_WAVEFORM_SAMPLE_INTERVAL_MS,
): Promise<MicrophoneTelemetryPoint[]> {
	const file = await loadAudioSourceFile(sourcePath);
	const wasmUrl = new URL("./wasm/web-demuxer.wasm", window.location.href).href;
	const demuxer = new WebDemuxer({ wasmFilePath: wasmUrl });
	let decoder: AudioDecoder | null = null;
	let decodeError: Error | null = null;
	try {
		await withTimeout(
			demuxer.load(file),
			SOURCE_LOAD_TIMEOUT_MS,
			"Timed out while parsing the recording audio.",
		);

		let decoderConfig: AudioDecoderConfig;
		try {
			decoderConfig = (await withTimeout(
				demuxer.getDecoderConfig("audio"),
				SOURCE_LOAD_TIMEOUT_MS,
				"Timed out while reading the recording audio track.",
			)) as AudioDecoderConfig;
		} catch {
			return [];
		}

		const sampleRate = decoderConfig.sampleRate || 48_000;
		const windowSizeFrames = Math.max(1, Math.round((sampleRate * sampleIntervalMs) / 1000));
		const support = await AudioDecoder.isConfigSupported(decoderConfig);
		if (!support.supported) {
			return [];
		}

		const accumulator: TelemetryAccumulator = {
			windowStartFrame: 0,
			processedFrames: 0,
			windowSumSquares: 0,
			windowSampleCount: 0,
			samples: [],
		};

		decoder = new AudioDecoder({
			output: (audioData) => {
				try {
					accumulateAudioData(audioData, accumulator, windowSizeFrames, sampleRate);
				} finally {
					audioData.close();
				}
			},
			error: (error) => {
				decodeError = new Error(`AudioDecoder error: ${error.message}`);
			},
		});
		decoder.configure(decoderConfig);

		const reader = (demuxer.read("audio") as ReadableStream<EncodedAudioChunk>).getReader();
		try {
			while (!decodeError) {
				const { done, value } = await reader.read();
				if (done || !value) {
					break;
				}
				decoder.decode(value);
				while (decoder.decodeQueueSize > DECODE_BACKPRESSURE_LIMIT && !decodeError) {
					await new Promise((resolve) => window.setTimeout(resolve, 1));
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				// Reader may already be closed once the audio stream finishes.
			}
		}

		if (decodeError) {
			throw decodeError;
		}

		if (decoder.state === "configured") {
			await decoder.flush();
		}
		if (decodeError) {
			throw decodeError;
		}

		flushTelemetryWindow(accumulator, sampleRate);
		return accumulator.samples;
	} finally {
		if (decoder && decoder.state !== "closed") {
			try {
				decoder.close();
			} catch {
				// Ignore teardown failures from best-effort waveform analysis.
			}
		}
		try {
			demuxer.destroy();
		} catch {
			// Ignore teardown failures from best-effort waveform analysis.
		}
	}
}
