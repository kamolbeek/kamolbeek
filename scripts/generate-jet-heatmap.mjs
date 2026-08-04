#!/usr/bin/env node
// Renders a GitHub contribution calendar as an SVG heatmap coloured with the
// classic "jet" colormap: dark blue -> blue -> cyan -> yellow -> red -> dark red.
//
//   node scripts/generate-jet-heatmap.mjs --user kamolbeek --out dist/github-jet.svg
//
// Data sources:
//   --source api   (default) GitHub GraphQL contribution calendar. Needs a token
//                  in GITHUB_TOKEN / GH_TOKEN / GH_PAT. A PAT with `read:user`
//                  also pulls in private contributions.
//   --source git   Counts commits from local clones. Used to seed the graph in
//                  environments that cannot reach the contributions API.
//
// No dependencies. Node 18+ (global fetch).

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { repo: [], authorEmail: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1)
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (Array.isArray(opts[camel])) opts[camel].push(value)
    else opts[camel] = value
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const USER = opts.user || process.env.GH_USER || 'kamolbeek'
const OUT = resolve(opts.out || 'dist/github-jet.svg')
const SOURCE = opts.source || 'api'
// 364 days back plus today is 365 days, which stays inside the API's one-year
// window while still filling the 53 columns GitHub itself shows.
const DAYS = Number(opts.days || 365)

// ---------------------------------------------------------------- date utils

const DAY_MS = 86_400_000
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS)
const utcDate = (s) => new Date(`${s}T00:00:00Z`)

const today = utcDate(iso(new Date()))
const rangeEnd = today
const rangeStart = addDays(rangeEnd, -(DAYS - 1))

// ---------------------------------------------------------------- data: api

async function fetchFromApi(login, from, to) {
  const token = process.env.GH_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!token) throw new Error('no token found in GH_PAT / GITHUB_TOKEN / GH_TOKEN')

  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){
    user(login:$login){
      contributionsCollection(from:$from,to:$to){
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ date contributionCount } }
        }
      }
    }
  }`

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'jet-heatmap',
    },
    body: JSON.stringify({
      query,
      variables: {
        login,
        from: `${iso(from)}T00:00:00Z`,
        to: `${iso(to)}T23:59:59Z`,
      },
    }),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${body?.message || '(no body)'}`)
  if (body?.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)

  const calendar = body?.data?.user?.contributionsCollection?.contributionCalendar
  if (!calendar) throw new Error(`no contribution calendar returned for "${login}"`)

  const counts = new Map()
  for (const week of calendar.weeks)
    for (const day of week.contributionDays) counts.set(day.date, day.contributionCount)
  return { counts, total: calendar.totalContributions }
}

// ---------------------------------------------------------------- data: git

function fetchFromGit(repoPaths, emails, from, to) {
  if (!repoPaths.length) throw new Error('--source git needs at least one --repo <path>')

  const counts = new Map()
  const wanted = emails.map((e) => e.toLowerCase())
  const seen = new Set()
  let total = 0

  for (const path of repoPaths) {
    let log
    try {
      log = execFileSync(
        'git',
        ['-C', path, 'log', '--all', '--no-merges', `--since=${iso(from)}`,
         `--until=${iso(addDays(to, 1))}`, '--date=short', '--format=%H%x09%ad%x09%ae'],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
      )
    } catch (err) {
      console.warn(`  ! skipping ${path}: ${err.message.split('\n')[0]}`)
      continue
    }

    for (const line of log.split('\n')) {
      if (!line) continue
      const [sha, date, email] = line.split('\t')
      if (seen.has(sha)) continue
      if (wanted.length && !wanted.some((e) => (email || '').toLowerCase().includes(e))) continue
      seen.add(sha)
      counts.set(date, (counts.get(date) || 0) + 1)
      total++
    }
  }

  return { counts, total }
}

// ---------------------------------------------------------------- jet colours

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const hex2 = (v) => Math.round(v * 255).toString(16).padStart(2, '0')

// Classic MATLAB jet: 0 -> #00007f, .125 -> blue, .375 -> cyan,
// .625 -> yellow, .875 -> red, 1 -> #7f0000.
function jet(t) {
  const x = clamp01(t)
  const r = clamp01(1.5 - Math.abs(4 * x - 3))
  const g = clamp01(1.5 - Math.abs(4 * x - 2))
  const b = clamp01(1.5 - Math.abs(4 * x - 1))
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

function quantile(sorted, q) {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// ---------------------------------------------------------------- svg render

const CELL = 11
const GAP = 3
const STEP = CELL + GAP
const PAD = 20
const LABEL_W = 30
const MONTH_H = 16
const TITLE_H = 26
const LEGEND_H = 38
const WEEKDAYS = [null, 'Mon', null, 'Wed', null, 'Fri', null]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))

function render({ login, counts, total, from, to }) {
  // Column 0 starts on the Sunday on or before `from`, so rows line up with
  // weekdays the way GitHub's own calendar does.
  const gridStart = addDays(from, -from.getUTCDay())
  const gridEnd = addDays(to, 6 - to.getUTCDay())
  const weeks = Math.round((gridEnd.getTime() - gridStart.getTime()) / DAY_MS + 1) / 7

  const nonzero = [...counts.values()].filter((c) => c > 0).sort((a, b) => a - b)
  // Cap at the 95th percentile so a single outlier day does not flatten the
  // rest of the year into the blue end of the ramp.
  const cap = Math.max(2, Math.round(quantile(nonzero, 0.95)))
  const logCap = Math.log1p(cap)
  const intensity = (c) => clamp01(Math.log1p(c) / logCap)

  const gridW = weeks * STEP - GAP
  const gridH = 7 * STEP - GAP
  const gridX = PAD + LABEL_W
  const gridY = PAD + TITLE_H + MONTH_H
  const width = PAD * 2 + LABEL_W + gridW
  const height = gridY + gridH + LEGEND_H + PAD

  const parts = []
  const monthLabels = []
  let lastMonth = -1
  let lastLabelCol = -99

  for (let col = 0; col < weeks; col++) {
    const colStart = addDays(gridStart, col * 7)
    // Label a column when its week opens a month, keeping labels from crowding
    // at the very start and end of the ramp.
    if (colStart.getUTCMonth() !== lastMonth) {
      lastMonth = colStart.getUTCMonth()
      if (col - lastLabelCol >= 3 && col <= weeks - 2) {
        monthLabels.push(
          `<text class="mut" x="${gridX + col * STEP}" y="${gridY - 6}">${MONTHS[lastMonth]}</text>`,
        )
        lastLabelCol = col
      }
    }

    for (let row = 0; row < 7; row++) {
      const day = addDays(colStart, row)
      if (day < from || day > to) continue

      const key = iso(day)
      const count = counts.get(key) || 0
      const x = gridX + col * STEP
      const y = gridY + row * STEP
      const fill = count > 0 ? jet(intensity(count)) : null
      const cls = count > 0 ? 'd' : 'd e'
      const attrs = fill ? ` fill="${fill}"` : ''
      const label = `${count} contribution${count === 1 ? '' : 's'} on ${key}`

      // Geometry stays on the element rather than in CSS: the `width`/`height`/`rx`
      // geometry properties are not reliable across every SVG renderer.
      parts.push(
        `<rect class="${cls}" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"${attrs}><title>${label}</title></rect>`,
      )
    }
  }

  const weekdayLabels = WEEKDAYS.map((name, row) =>
    name ? `<text class="mut" x="${gridX - 8}" y="${gridY + row * STEP + CELL - 2}" text-anchor="end">${name}</text>` : '',
  ).join('')

  // Legend: the full ramp sampled densely enough to read as continuous.
  const stops = Array.from({ length: 21 }, (_, i) => {
    const t = i / 20
    return `<stop offset="${(t * 100).toFixed(0)}%" stop-color="${jet(t)}"/>`
  }).join('')

  // Lay the legend out right-to-left so the "N+" label always lands inside the
  // card instead of overflowing the right edge on large contribution counts.
  const maxLabel = `${cap}+`
  const maxLabelW = maxLabel.length * 6
  const legendW = 132
  const legendY = gridY + gridH + 18
  const legendRight = width - PAD - maxLabelW - 8
  const legendX = legendRight - legendW

  const rangeText = `${iso(from)} → ${iso(to)}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(login)} GitHub contribution heatmap, jet colormap, ${total} contributions">
<title>${esc(login)} — ${total} contributions (${rangeText})</title>
<defs>
  <linearGradient id="jet" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>
</defs>
<style>
  .bg   { fill: #0d1117; stroke: #30363d; }
  .fg   { fill: #e6edf3; }
  .mut  { fill: #8b949e; }
  .e    { fill: #161b22; }
  text  { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 10px; }
  .t    { font-size: 14px; font-weight: 600; }
  .n    { font-size: 12px; }
  @media (prefers-color-scheme: light) {
    .bg  { fill: #ffffff; stroke: #d0d7de; }
    .fg  { fill: #1f2328; }
    .mut { fill: #59636e; }
    .e   { fill: #eff2f5; }
  }
</style>
<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10"/>
<text class="fg t" x="${PAD}" y="${PAD + 14}">${esc(login)}</text>
<text class="mut n" x="${width - PAD}" y="${PAD + 14}" text-anchor="end">${total} contributions · ${rangeText}</text>
${monthLabels.join('')}
${weekdayLabels}
${parts.join('')}
<text class="mut" x="${PAD}" y="${legendY + 12}">jet colormap · cell colour scales with that day's commits</text>
<text class="mut" x="${legendX - 8}" y="${legendY + 12}" text-anchor="end">0</text>
<rect x="${legendX}" y="${legendY + 2}" width="${legendW}" height="11" rx="2" fill="url(#jet)"/>
<text class="mut" x="${width - PAD}" y="${legendY + 12}" text-anchor="end">${maxLabel}</text>
</svg>
`
}

// ---------------------------------------------------------------- main

const { counts, total } =
  SOURCE === 'git'
    ? fetchFromGit(opts.repo, opts.authorEmail, rangeStart, rangeEnd)
    : await fetchFromApi(USER, rangeStart, rangeEnd)

const svg = render({ login: USER, counts, total, from: rangeStart, to: rangeEnd })

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, svg)

const active = [...counts.values()].filter((c) => c > 0).length
console.log(`jet-heatmap: ${OUT}`)
console.log(`  source ${SOURCE} · user ${USER} · ${iso(rangeStart)} → ${iso(rangeEnd)}`)
console.log(`  ${total} contributions across ${active} active days`)

if (SOURCE === 'api' && !process.env.GH_PAT) {
  console.log('')
  console.log('  note: GITHUB_TOKEN only sees public contributions, so work in private')
  console.log('        repositories is missing from this graph. To include it, create a')
  console.log('        PAT with the read:user and repo scopes, save it as the GH_PAT')
  console.log('        repository secret, and re-run this workflow.')
}
