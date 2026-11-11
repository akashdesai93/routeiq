import type { FC } from 'react'
import type { Scene } from '../scene'

export type Direction = {
  id: string
  name: string
  idea: string
  palette: string
  type: string
  /** Light status bar and home indicator, for a dark screen */
  dark: boolean
  /** The screen's ground, any CSS background */
  ground: string
  Pick: FC
  Drive: FC<{ s: Scene }>
}
