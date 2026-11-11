/** The one place that says which pin is which, and what it looks like. */
export type PinRole = 'origin' | 'destination'

export const PIN_ROLES: readonly PinRole[] = ['origin', 'destination']

export const PIN_COLOR: Readonly<Record<PinRole, string>> = {
  origin: '#1f6feb',
  destination: '#d1242f',
}

export const PIN_NAME: Readonly<Record<PinRole, string>> = {
  origin: 'Origin',
  destination: 'Destination',
}
