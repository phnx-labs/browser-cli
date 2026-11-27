| Tool | Version | Correct | Turns/task | Seconds/task | Tokens/task | Cost/task |
|---|---|---:|---:|---:|---:|---:|
| browser-harness | 0.1.15 | 16/16 | 6.44 | 23.7 | 105k | $0.0642 |
| browser-cli | 0.2.17 (13f3259) | 16/16 | 5.81 | 14.3 | 91k | $0.0575 |
| browser-use | 1.0.9 | 16/16 | 5.69 | 15.4 | 86k | $0.0555 |
| agent-browser | 0.45.0 | 16/16 | 11.25 | 21.9 | 216k | $0.0885 |

| Task | browser-harness | browser-cli | browser-use | agent-browser |
|---|---|---|---|---|
| books | 2/2, 4.0 turns, 10 s | 2/2, 6.0 turns, 15 s | 2/2, 5.0 turns, 11 s | 2/2, 11.5 turns, 22 s |
| pizza | 2/2, 6.5 turns, 15 s | 2/2, 5.0 turns, 12 s | 2/2, 5.5 turns, 12 s | 2/2, 11.0 turns, 20 s |
| bun | 2/2, 11.5 turns, 61 s | 2/2, 5.0 turns, 11 s | 2/2, 6.0 turns, 12 s | 2/2, 9.0 turns, 16 s |
| saucedemo | 2/2, 7.5 turns, 23 s | 2/2, 7.0 turns, 16 s | 2/2, 7.0 turns, 18 s | 2/2, 16.5 turns, 29 s |
| laptops | 2/2, 5.5 turns, 21 s | 2/2, 5.0 turns, 14 s | 2/2, 5.5 turns, 16 s | 2/2, 10.0 turns, 21 s |
| demoblaze | 2/2, 7.5 turns, 38 s | 2/2, 7.5 turns, 24 s | 2/2, 7.0 turns, 33 s | 2/2, 15.0 turns, 34 s |
| instagram | 2/2, 4.0 turns, 11 s | 2/2, 4.5 turns, 9 s | 2/2, 4.5 turns, 9 s | 2/2, 8.0 turns, 14 s |
| wikipedia | 2/2, 5.0 turns, 10 s | 2/2, 6.5 turns, 14 s | 2/2, 5.0 turns, 11 s | 2/2, 9.0 turns, 18 s |

| Tool | Version | Tasks solved | Agent runs that saw another agent's tab | Wall seconds/trial |
|---|---|---:|---:|---:|
| browser-harness | 0.1.15 | 6/6 | 0/6 | 15 |
| browser-cli | 0.2.17 (13f3259) | 6/6 | 0/6 | 21 |
| browser-use | 1.0.9 | 6/6 | 4/6 | 31 |
| agent-browser | 0.45.0 | 6/6 | 5/6 | 73 |

Runs: 64 suite, 8 isolation trials. Model spend reported by Claude Code: $6.24.
