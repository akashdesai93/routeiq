import type { CSSProperties } from 'react'
import { useLook } from '../looks'
import './BrandMark.css'

// RouteIQ copy: the upstream kit's bundled third-party brand artwork
// (kit/brands) is not vendored in this public repo. BrandMark keeps its
// neutral path only: a caller-supplied logo (`src`) or the initial tile.
export type BrandMarkProps = {
  name: string
  src?: string
  size?: number
  width?: number
  tile?: boolean
  /** The surface behind the mark. Defaults to the Stage theme. */
  surface?: 'light' | 'dark'
  className?: string
  style?: CSSProperties
}

/** A caller-supplied logo, or the neutral initial tile when there is none. */
export function BrandMark({ name, src, size = 28, width, tile = true, className, style }: BrandMarkProps) {
  const { fidelity } = useLook()
  return (
    <span className={`ss-brand${className ? ` ${className}` : ''}`} data-tile={tile || undefined} style={{ width: width ?? size, height: size, borderRadius: Math.round(size * 0.24), ...style }} role="img" aria-label={name}>
      {src && fidelity !== 'minimal'
        ? <img src={src} alt="" draggable={false} />
        : <span className="ss-brand__initial" style={{ fontSize: Math.round(size * (size < 24 ? 0.5 : 0.42)) }}>{fidelity === 'minimal' ? '' : name.trim()[0]?.toUpperCase()}</span>}
    </span>
  )
}
