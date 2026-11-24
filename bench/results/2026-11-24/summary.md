| Tool | Version | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| browser-harness | 0.1.14 | 16/16 | 6.38 | 25.0 | 103k | $0.0590 |
| browser-cli | 0.2.16 (d723c32) | 16/16 | 5.50 | 13.8 | 82k | $0.0471 |
| browser-use | 1.0.8 | 16/16 | 5.56 | 15.8 | 84k | $0.0511 |
| agent-browser | 0.44.0 | 16/16 | 10.94 | 23.8 | 212k | $0.0828 |

| Task | browser-harness | browser-cli | browser-use | agent-browser |
|---|---|---|---|---|
| books | 2/2, 5.5 turns, 15 s | 2/2, 5.0 turns, 11 s | 2/2, 5.0 turns, 12 s | 2/2, 9.0 turns, 19 s |
| pizza | 2/2, 6.0 turns, 15 s | 2/2, 5.0 turns, 12 s | 2/2, 5.5 turns, 12 s | 2/2, 10.0 turns, 18 s |
| bun | 2/2, 12.0 turns, 68 s | 2/2, 4.0 turns, 9 s | 2/2, 6.0 turns, 13 s | 2/2, 9.0 turns, 16 s |
| saucedemo | 2/2, 6.5 turns, 22 s | 2/2, 6.5 turns, 17 s | 2/2, 6.0 turns, 17 s | 2/2, 21.0 turns, 53 s |
| laptops | 2/2, 5.0 turns, 21 s | 2/2, 5.0 turns, 14 s | 2/2, 6.0 turns, 17 s | 2/2, 8.5 turns, 21 s |
| demoblaze | 2/2, 7.0 turns, 37 s | 2/2, 8.0 turns, 26 s | 2/2, 6.5 turns, 33 s | 2/2, 13.5 turns, 32 s |
| instagram | 2/2, 4.0 turns, 12 s | 2/2, 4.0 turns, 8 s | 2/2, 4.5 turns, 12 s | 2/2, 8.5 turns, 16 s |
| wikipedia | 2/2, 5.0 turns, 11 s | 2/2, 6.5 turns, 13 s | 2/2, 5.0 turns, 10 s | 2/2, 8.0 turns, 15 s |

| Tool | Version | Tasks solved | Agent runs that saw another agent's tab | Wall seconds/trial |
|---|---|---:|---:|---:|
| browser-harness | 0.1.14 | 6/6 | 0/6 | 16 |
| browser-cli | 0.2.16 (d723c32) | 6/6 | 0/6 | 26 |
| browser-use | 1.0.8 | 6/6 | 5/6 | 33 |
| agent-browser | 0.44.0 | 6/6 | 6/6 | 65 |

Runs: 64 suite, 8 isolation trials. Model spend reported by Claude Code: $5.90.
