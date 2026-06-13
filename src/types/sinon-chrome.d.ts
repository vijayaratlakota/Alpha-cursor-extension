// Ambient declaration for `sinon-chrome`.
//
// The package ships plain JavaScript with no bundled types, and there is no
// `@types/sinon-chrome` package on npm to install. Without a declaration the
// import is implicitly `any` (TS7016) under the strict tsconfig.
//
// The router tests use the imported binding two ways:
//   * as a value with sinon stub members (`chrome.reset()`,
//     `chrome.runtime.onMessage.addListener.calledOnce`, `.firstCall.args`)
//   * as a type namespace (`chrome.runtime.MessageSender`)
//
// So we model sinon-chrome's default export as a namespace that carries both
// the value members the tests touch and the `MessageSender` type. This stays
// self-contained and does not weaken or shadow the real `@types/chrome` global.
declare module "sinon-chrome" {
  namespace SinonChrome {
    /** Minimal shape of a sinon stub, covering the assertions used in tests. */
    interface SinonStub {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (...args: any[]): any;
      called: boolean;
      calledOnce: boolean;
      callCount: number;
      // `args` is intentionally loosely typed: the tests pull the registered
      // listener out of `firstCall.args[0]` and invoke it directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      firstCall: { args: any[] };
      reset(): void;
    }

    namespace runtime {
      // Alias the real `@types/chrome` MessageSender so test code that casts
      // `{} as chrome.runtime.MessageSender` (where `chrome` is this import)
      // stays assignable to the production `dispatch(..)` signature.
      type MessageSender = globalThis.chrome.runtime.MessageSender;

      const onMessage: { addListener: SinonStub; [key: string]: SinonStub };
      const sendMessage: SinonStub;
    }

    /** Resets all stubbed behaviour and recorded calls. */
    function reset(): void;
    /** Resets stub history without clearing configured behaviour. */
    function flush(): void;
  }

  export default SinonChrome;
}
