// Canvas text uses a font only after it has loaded. Every scene yields this promise first.

let ready: Promise<unknown> | null = null;

export function fontsReady() {
  ready ??= Promise.all(
    ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 32px Inter`)).concat(
      ['400', '500'].map((w) => document.fonts.load(`${w} 32px "JetBrains Mono"`)),
    ),
  );
  return ready;
}
