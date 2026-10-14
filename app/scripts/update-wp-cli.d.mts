export interface PharAssets {
  version: string
  url: string
  size: number
  sha512Url: string
}
export interface WpCliPin {
  version: string
  url: string
  sha512: string
  size: number
}
export function pharAssets(release: { tag_name?: string; assets?: Array<{ name: string; size: number; browser_download_url: string }> }): PharAssets
export function parseSha512(text: string): string
export function renderPin(pin: WpCliPin): string
export function pinnedVersion(source: string): string | undefined
