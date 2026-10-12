export const SIZE: 800;
export type CoverVariant = "a" | "b" | "c";
export interface CoverMetadata {
  id?: string;
  albumKey?: string;
  title?: string;
  artist?: string;
  language?: string;
}
export interface CoverLayout {
  variant: CoverVariant;
  title: string;
  artist: string;
  lines: string[];
  size: number;
  height: number;
  titleHeight: number;
  truncated: boolean;
  width: 800;
}
export const variants: ReadonlyArray<{
  id: CoverVariant;
  label: string;
  note: string;
  weight: number;
  maximum: number;
  minimum: number;
  leading: number;
  pad: number;
  ink: string;
  muted: string;
  rule: string;
  palettes: string[];
}>;
export const samples: ReadonlyArray<CoverMetadata>;
export function coverWords(text: string, protectedTerms?: string[]): Array<{ text: string; spaceBefore: boolean }>;
export function loadFonts(): Promise<void>;
export function drawCover(canvas: HTMLCanvasElement, metadata: CoverMetadata, variantId: CoverVariant): CoverLayout;
