/**
 * ONBOARDING FEATURE — barrel. The first-run flow (app/onboarding.tsx) composes:
 *   • Carousel    — the paged story (scenes + headlines + animated dots)
 *   • scenes      — the animated SVG hero art for each slide
 *   • StartPanel  — the frictionless finish: optional name + starter stack + CTA
 */
export { Carousel } from "./Carousel";
export type { Slide } from "./Carousel";
export { StartPanel } from "./StartPanel";
export { SceneMarketPop, SceneInstantPay, SceneLiveSlate } from "./scenes";
