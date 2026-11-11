import { DEMOS, DIRECTIONS } from './demos'
import './gallery.css'

// The page the owner looks at: the comparison first, then each direction with
// its three screens and its looping hero moment.
const SCREENS: [string, string][] = [
  ['pick', 'Pick a route'],
  ['drive', 'Driving'],
  ['switch', 'The automatic switch'],
  ['loop', 'Hero moment, looping'],
]

export function Gallery() {
  const Compare = DEMOS.compare
  return (
    <main className="gl">
      <header className="gl-head">
        <p className="gl-kicker">RouteIQ · UI directions</p>
        <h1>Three ways it could look</h1>
        <p className="gl-lede">
          Same trip, same three screens, three different ideas. Uptown Charlotte to Indian Land, SC. The loop below is the moment the app finds a faster route and
          switches by itself.
        </p>
      </header>

      <section className="gl-compare">
        <Compare />
      </section>

      {DIRECTIONS.map((d, i) => (
        <section key={d.id} className="gl-dir">
          <div className="gl-dir__head">
            <h2>
              <span>{i + 1}</span>
              {d.name}
            </h2>
            <p>{d.idea}</p>
            <dl>
              <dt>Palette</dt>
              <dd>{d.palette}</dd>
              <dt>Type</dt>
              <dd>{d.type}</dd>
            </dl>
          </div>
          <div className="gl-dir__row">
            {SCREENS.map(([key, label]) => {
              const Demo = DEMOS[`${d.id}-${key}`]
              return (
                <figure key={key}>
                  <Demo />
                  <figcaption>
                    <a href={`?capture=${d.id}-${key}`}>{label}</a>
                  </figcaption>
                </figure>
              )
            })}
          </div>
        </section>
      ))}

      <footer className="gl-foot">
        <a href="?capture=merged-compare">The merged direction (chosen)</a>
        <a href="?capture=merged-loop">Merged switch loop</a>
        <a href="?capture=compare">Comparison alone</a>
        <a href="?capture=compare-all">All nine screens on one sheet</a>
      </footer>
    </main>
  )
}
