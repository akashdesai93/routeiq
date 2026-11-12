/**
 * A figure as it is typeset in the approved design: the digits large, the unit
 * small and dim beside them (`unitClass`). The text itself is unchanged
 * ("0.8 mi" still reads "0.8 mi"). Shared by the drive view and the route list.
 */
export function Figure({ text, unitClass }: { text: string; unitClass: string }) {
  return (
    <>
      {text.split(/(\d[\d.,:]*)/).map((part, i) =>
        part === '' ? null : i % 2 === 1 ? (
          part
        ) : (
          <span key={i} className={unitClass}>
            {part}
          </span>
        ),
      )}
    </>
  )
}
