// Imported first by src/social.ts: everything loaded after it renders the short cut for social media
// (timeline.ts reads the flag once, when it is loaded).

(globalThis as { __CUT?: string }).__CUT = 'social';

export {};
