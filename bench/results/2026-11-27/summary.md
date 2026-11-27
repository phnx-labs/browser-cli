| Tool | Version | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| browser-harness | 0.1.15 | 16/16 | 6.13 | 27.8 | 96k | $0.0651 |
| browser-cli | 0.2.18 (727f57a) | 16/16 | 5.56 | 13.9 | 82k | $0.0558 |
| browser-use | 1.0.9 | 16/16 | 5.81 | 17.8 | 90k | $0.0614 |
| agent-browser | 0.45.0 | 16/16 | 11.06 | 20.6 | 206k | $0.0876 |

| Task | browser-harness | browser-cli | browser-use | agent-browser |
|---|---|---|---|---|
| books | 2/2, 4.5 turns, 12 s | 2/2, 5.5 turns, 13 s | 2/2, 4.5 turns, 11 s | 2/2, 9.5 turns, 20 s |
| pizza | 2/2, 8.5 turns, 18 s | 2/2, 5.0 turns, 12 s | 2/2, 5.5 turns, 12 s | 2/2, 12.5 turns, 23 s |
| bun | 2/2, 10.5 turns, 44 s | 2/2, 5.0 turns, 13 s | 2/2, 5.0 turns, 12 s | 2/2, 9.0 turns, 16 s |
| saucedemo | 2/2, 5.5 turns, 19 s | 2/2, 6.0 turns, 15 s | 2/2, 10.0 turns, 31 s | 2/2, 17.0 turns, 27 s |
| laptops | 2/2, 4.5 turns, 16 s | 2/2, 5.5 turns, 15 s | 2/2, 5.5 turns, 19 s | 2/2, 9.5 turns, 20 s |
| demoblaze | 2/2, 6.5 turns, 92 s | 2/2, 7.5 turns, 23 s | 2/2, 7.0 turns, 37 s | 2/2, 14.5 turns, 29 s |
| instagram | 2/2, 4.0 turns, 11 s | 2/2, 4.0 turns, 8 s | 2/2, 4.0 turns, 9 s | 2/2, 8.0 turns, 14 s |
| wikipedia | 2/2, 5.0 turns, 10 s | 2/2, 6.0 turns, 12 s | 2/2, 5.0 turns, 10 s | 2/2, 8.5 turns, 15 s |

| Tool | Version | Tasks solved | Agent runs that saw another agent's tab | Wall seconds/trial |
|---|---|---:|---:|---:|
| browser-harness | 0.1.15 | 6/6 | 0/6 | 22 |
| browser-cli | 0.2.18 (727f57a) | 6/6 | 0/6 | 13 |
| browser-use | 1.0.9 | 6/6 | 4/6 | 40 |
| agent-browser | 0.45.0 | 6/6 | 5/6 | 81 |

Runs: 64 suite, 8 isolation trials. Model spend reported by Claude Code: $6.30.
