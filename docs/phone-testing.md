# Testing RouteIQ on your iPhone

The web app is published to GitHub Pages at **https://akashdesai93.github.io/routeiq/**
by `.github/workflows/pages.yml`, on every push to `main` (changes under `native/` and
`design/` alone don't trigger it) and on demand. GitHub Pages serves it over HTTPS, which
the phone needs before it hands the page a GPS position.

## One-time setup (owner, about 5 minutes)

1. **Create a Mapbox token for the site.** At
   https://console.mapbox.com/account/access-tokens/ choose *Create a token*, keep the
   default public scopes (it starts with `pk.`, never `sk.`), and under *URL restrictions*
   add exactly `https://akashdesai93.github.io`. Use a separate token from your
   `localhost` one, so either can be revoked on its own.
2. **Add it as a repo secret.** GitHub → the repo → Settings → Secrets and variables →
   Actions → *New repository secret*. Name: `VITE_MAPBOX_TOKEN_PAGES`. Value: the token.
   (Or from a terminal: `gh secret set VITE_MAPBOX_TOKEN_PAGES` and paste it when asked.)
3. **Turn Pages on.** Settings → Pages → Build and deployment → Source: **GitHub Actions**.
4. **Deploy.** Either push to `main`, or run the workflow by hand:
   `gh workflow run pages.yml` (or Actions → Pages → *Run workflow*). Watch it with
   `gh run watch`. The *deploy* job prints the site URL when it is done.
   Until the secret is set, a push to `main` skips the deployment (the run succeeds with
   the notice "Pages deploy skipped") and a run started by hand fails with "Set the
   VITE_MAPBOX_TOKEN_PAGES secret". With the secret set but Pages off, the
   *configure-pages* step fails, so do steps 2 and 3 together.

## On the phone

1. Open **https://akashdesai93.github.io/routeiq/** in **Safari**.
2. Tap **Use my location** once and choose **Allow** (Safari asks per site). If you
   tapped *Don't Allow* earlier: Settings → Apps → Safari → Location → *Ask* or *Allow*,
   and Settings → Privacy & Security → Location Services → Safari Websites → *While Using*.
3. **Add to Home Screen:** the Share button → *Add to Home Screen*. It opens full screen
   with the RouteIQ icon. The home-screen app asks for location again the first time.
   If the screen still dims during a drive from the home-screen app, use it in Safari
   instead (older iOS versions don't hold the screen awake for home-screen web apps).

## Driving tips

- **Keep the screen on and RouteIQ in front.** A web page stops while the phone is
  locked or another app is open: no position, no checks, no voice. RouteIQ asks to keep
  the screen awake during a drive and says how long it was paused when it comes back.
  Set Auto-Lock to *Never* for the test if the screen dims anyway (a warning in the
  drive view says when the wake lock was not granted).
- **Use a mount, or have a passenger operate it.** Plan the trip before you set off.
- **Voice needs one tap first.** iPhone browsers only speak after a tap, so the
  *Start drive* tap itself says "RouteIQ started". If you hear nothing: turn the volume up,
  check the ring/silent switch, and check Voice behind More in the drive view.
- Planning and the side-street routes work from the couch; only the live drive needs
  the car.

## What to note while testing

For each trip, a line or two is enough (time, from, to):

- **Route chosen:** which route RouteIQ recommended, and whether you'd have picked it.
- **Side street offered:** did a side-street route show up, and did it make sense?
- **Switches:** when it changed route mid-drive, what it said, and whether the switch was
  right (or came too late, or flapped).
- **Wrong turns:** how fast it noticed you were off the route and what it did next.
- Anything odd: GPS jumps, a turn prompt at the wrong moment, the screen dimming,
  the voice cutting out, the page reloading.

## Cost and abuse

The site is public: anyone with the URL can load it and spend your Mapbox quota (the
URL restriction stops other sites from using the token, not people visiting this one).

- In the Mapbox console (Account → Billing) **set a billing alert** at a small amount.
- Free tiers per month: about **100,000 Directions requests** and about **500 Search Box
  sessions** (search is the one that runs out first; each search you type is a session).
  Map loads have their own, larger free tier.
- To shut it off fast: delete or rotate the token in the Mapbox console (the site then
  shows a token error), or Settings → Pages → *Unpublish site*.

## Privacy

The hosted site behaves exactly like local development: what goes to Mapbox (route
endpoints, the live-drive position, typed searches) is the same, and GitHub Pages only
serves the app's static files. See README, Privacy.
