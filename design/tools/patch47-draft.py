import io
def rw(p,f):
    s=io.open(p,encoding='utf8').read(); s2=f(s); assert s2!=s, p; io.open(p,'w',encoding='utf8',newline='\n').write(s2)
def tsx(s):
    s=s.replace("function NavMap({ s, day, route = true, youY = YOU.y }: { s: MScene; day?: boolean; route?: boolean; youY?: number }) {","function NavMap({ s, day, route = true, youY = YOU.y, backdrop }: { s: MScene; day?: boolean; route?: boolean; youY?: number; backdrop?: string }) {")
    s=s.replace("          <Streets />\n","          {backdrop ? <image href={backdrop} x={0} y={0} width={402} height={874} preserveAspectRatio=\"xMidYMid slice\" /> : <Streets />}\n")
    s=s.replace("export function Drive({ s, day, signals = 'full', known = 9 }: { s: MScene; day?: boolean; signals?: Signals; known?: number }) {","export function Drive({ s, day, signals = 'full', known = 9, backdrop }: { s: MScene; day?: boolean; signals?: Signals; known?: number; backdrop?: string }) {")
    s=s.replace("<NavMap s={s} day={day} />","<NavMap s={s} day={day} backdrop={backdrop} />")
    return s
rw('src/merged/index.tsx',tsx)
def demos(s):
    s=s.replace("import './demos.css'","import lightMap from '../../reference/mapbox-screenshots-internal-not-for-publishing/phone-backdrop-light.png'\nimport darkMap from '../../reference/mapbox-screenshots-internal-not-for-publishing/phone-backdrop-dark-derived.png'\nimport './demos.css'")
    s=s.replace("// Everything on one sheet","""// #47: the overlays over a real map still. Internal reference only: the map
// imagery is Mapbox / OpenStreetMap and must not be published.
const REAL: [string, MScene][] = [
  ['Driving', M_DRIVE],
  ['Switch, pending', M_PENDING],
  ['Switch, confirmed', M_CONFIRMED],
]
const RealMap: FC = () => (
  <Stage width={1300} height={1760} unframed specimen className="rq-all mgx-sheet">
    {() => (
      <div className="mgx-sheet__grid mgx-sheet__grid--tight">
        {[false, true].map((dark) => (
          <div key={String(dark)} className="mgx-sheet__row">
            {REAL.map(([label, scene]) => (
              <div key={label} className="mgx-sheet__col">
                <Shot w={SHEET.phone} day={!dark}>
                  <Drive s={scene} day={!dark} backdrop={dark ? darkMap : lightMap} />
                </Shot>
                <div className="mgx-sheet__cap">
                  {label} · {dark ? 'dark map (derived)' : 'light map (prototype still)'}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    )}
  </Stage>
)

// Everything on one sheet""")
    s=s.replace("  'merged-turn-cards': TurnCards,","  'merged-turn-cards': TurnCards,\n  'merged-real-map': RealMap,")
    return s
rw('src/merged/demos.tsx',demos)
