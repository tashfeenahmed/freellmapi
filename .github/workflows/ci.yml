name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: Test & build (Node ${{ matrix.node-version }})
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        # The supported engines range (package.json: >=20.18 <25). 20 is the
        # CI baseline that has historically caught crashes newer local Node
        # versions hid; 22 is the LTS most contributors run; 24 is what the
        # Docker image ships since the Node 20 line reached end of life.
        node-version: ['20', '22', '24']
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Check migration round trip
        run: npm run test:migrations

      # COVERAGE makes the server suite collect coverage inside this run rather
      # than running the whole suite a second time. Only the Node 22 leg sets
      # it, so the Node 20 leg keeps uninstrumented timings. Reporting only,
      # there are no thresholds and coverage never fails the build.
      - name: Run tests
        env:
          COVERAGE: ${{ matrix.node-version == '22' && '1' || '' }}
        run: npm test

      # server + cli only; the client has its own backlog of ESLint violations
      # and is brought in under a separate change.
      - name: Lint
        run: npm run lint

      - name: Build workspaces
        run: npm run build
