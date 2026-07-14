import type { PublicCardConfig } from './config'
import type { SourceSplitItem } from '../usage/source-format'

export type UsageCardInput = {
  displayName: string
  publicUrl: string
  totalTokens: number
  totalTokensWithoutCacheRead?: number
  totalCacheReadRate?: number
  totalCostUsd: number
  totalCostAvailable?: boolean
  monthTokens: number
  monthTokensWithoutCacheRead?: number
  monthCacheReadRate?: number
  monthCostUsd: number
  monthCostAvailable?: boolean
  todayTokens?: number
  todayTokensWithoutCacheRead?: number
  todayCacheReadRate?: number
  todayCostUsd?: number
  todayCostAvailable?: boolean
  sourceSplit?: SourceSplitItem[]
}

export type Palette = {
  bgStart: string
  bgEnd: string
  panel: string
  panelStrong: string
  text: string
  muted: string
  border: string
  logoPanelStart: string
  logoPanelEnd: string
  shadow: string
  highlightText: string
}

export const palettes = {
  dark: {
    bgStart: '#161a13',
    bgEnd: '#0c0d0a',
    panel: '#151812',
    panelStrong: '#10130f',
    text: '#fafaf9',
    muted: '#a8a29e',
    border: '#78716c',
    logoPanelStart: '#272a22',
    logoPanelEnd: '#11130f',
    shadow: '#090a08',
    highlightText: '#bef264'
  },
  light: {
    bgStart: '#fffef8',
    bgEnd: '#ede6d8',
    panel: '#f8f4ec',
    panelStrong: '#ffffff',
    text: '#1c1917',
    muted: '#57534e',
    border: '#a8a29e',
    logoPanelStart: '#f8f4ec',
    logoPanelEnd: '#e7dccb',
    shadow: '#f4f0e8',
    highlightText: '#365314'
  }
} as const satisfies Record<PublicCardConfig['theme'], Palette>
