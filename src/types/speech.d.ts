// Ambient declarations for the Web Speech API recognition surface
// (Tool 11 — Voice to Text, Req 16).
//
// The Web Speech API's `SpeechRecognition` /
// `webkitSpeechRecognition` (https://developer.mozilla.org/docs/Web/API/SpeechRecognition)
// is implemented in Chromium-based browsers but is NOT part of the
// `lib.dom.d.ts` shipped with the project's TypeScript version. Without this
// minimal declaration, `window.SpeechRecognition` / `window.webkitSpeechRecognition`
// and the recognition event shapes would error under the strict tsconfig.
//
// We model only the surface the voice transcriber touches: the constructor, the
// `continuous` / `interimResults` / `lang` flags, `start()` / `stop()` /
// `abort()`, and the `result` / `error` / `end` events with the result-list
// shape used to assemble interim + final transcripts.

/** A single recognition alternative (hypothesis) for a result. */
interface SpeechRecognitionAlternative {
  /** The recognized text for this alternative. */
  readonly transcript: string;
  /** Confidence score in `[0, 1]` (may be `0` for interim results). */
  readonly confidence: number;
}

/**
 * One recognition result. Indexable by alternative; `isFinal` distinguishes a
 * settled (final) result from a still-changing interim one (Req 16.3).
 */
interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  /** `true` once this result is final (no longer interim). */
  readonly isFinal: boolean;
}

/** The list of results delivered on a `result` event. */
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

/** Event delivered on the recognition `result` event. */
interface SpeechRecognitionEvent extends Event {
  /** Index of the first result that changed in this event. */
  readonly resultIndex: number;
  /** The full results list (interim + final) accumulated so far. */
  readonly results: SpeechRecognitionResultList;
}

/**
 * Error codes surfaced on the recognition `error` event. `not-allowed` and
 * `service-not-allowed` indicate the microphone permission was denied (Req 16.5).
 */
type SpeechRecognitionErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "bad-grammar"
  | "language-not-supported";

/** Event delivered on the recognition `error` event. */
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: SpeechRecognitionErrorCode;
  readonly message: string;
}

/**
 * A speech-recognition session. Setting `continuous` keeps recognition running
 * across pauses; `interimResults` streams not-yet-final hypotheses (Req 16.3).
 * Calling `start()` triggers the browser microphone-permission prompt (Req 16.2).
 */
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;

  start(): void;
  stop(): void;
  abort(): void;

  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown)
    | null;
  onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;

  addEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** Event map for {@link SpeechRecognition}'s typed `addEventListener`. */
interface SpeechRecognitionEventMap {
  result: SpeechRecognitionEvent;
  error: SpeechRecognitionErrorEvent;
  end: Event;
  start: Event;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
