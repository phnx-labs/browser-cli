| Tool | Version | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| browser-harness | 0.1.13 | 16/16 | 5.56 | 20.4 | 82k | $0.0502 |
| browser-cli | 0.2.3 (b5779f7) | 16/16 | 5.88 | 17.1 | 89k | $0.0472 |
| browser-use | 0.13.14 | 16/16 | 5.69 | 19.7 | 91k | $0.0584 |
| agent-browser | 0.41.2 | 16/16 | 14.75 | 35.8 | 267k | $0.0970 |

| Task | browser-harness | browser-cli | browser-use | agent-browser |
|---|---|---|---|---|
| books | 2/2, 4.0 turns, 12 s | 2/2, 5.0 turns, 14 s | 2/2, 4.5 turns, 13 s | 2/2, 8.5 turns, 22 s |
| pizza | 2/2, 5.0 turns, 15 s | 2/2, 5.0 turns, 14 s | 2/2, 5.0 turns, 13 s | 2/2, 12.5 turns, 27 s |
| bun | 2/2, 8.0 turns, 28 s | 2/2, 4.0 turns, 11 s | 2/2, 6.5 turns, 22 s | 2/2, 14.5 turns, 37 s |
| saucedemo | 2/2, 6.5 turns, 25 s | 2/2, 6.0 turns, 20 s | 2/2, 7.0 turns, 24 s | 2/2, 25.5 turns, 71 s |
| laptops | 2/2, 5.0 turns, 20 s | 2/2, 5.5 turns, 18 s | 2/2, 5.5 turns, 21 s | 2/2, 22.5 turns, 46 s |
| demoblaze | 2/2, 6.5 turns, 34 s | 2/2, 9.0 turns, 30 s | 2/2, 7.5 turns, 40 s | 2/2, 16.5 turns, 44 s |
| instagram | 2/2, 4.0 turns, 16 s | 2/2, 4.5 turns, 10 s | 2/2, 4.5 turns, 12 s | 2/2, 8.0 turns, 18 s |
| wikipedia | 2/2, 5.5 turns, 14 s | 2/2, 8.0 turns, 20 s | 2/2, 5.0 turns, 13 s | 2/2, 10.0 turns, 22 s |

| Tool | Version | Tasks solved | Agent runs that saw another agent's tab | Wall seconds/trial |
|---|---|---:|---:|---:|
| browser-harness | 0.1.13 | 6/6 | 6/6 | 27 |
| browser-cli | 0.2.3 (b5779f7) | 6/6 | 0/6 | 83 |
| browser-use | 0.13.14 | 6/6 | 4/6 | 34 |
| agent-browser | 0.41.2 | 6/6 | 6/6 | 54 |

Runs: 64 suite, 8 isolation trials. Model spend reported by Claude Code: $5.94.
