export {};

declare global {
  interface Window {
    __wheelsOcrDebug?: any;
    Alpine?: unknown;
    ort?: any;
  }

  interface Navigator {
    connection?: { saveData?: boolean; effectiveType?: string };
    mozConnection?: { saveData?: boolean; effectiveType?: string };
    webkitConnection?: { saveData?: boolean; effectiveType?: string };
    gpu?: any;
  }

  interface WorkerNavigator {
    gpu?: any;
  }

  interface Error {
    /** Set when the ONNX pipeline asks the caller to fall back to Tesseract. */
    isFallback?: boolean;
  }
}
