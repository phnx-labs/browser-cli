# Design in Figma

<p align="center"><img src="../assets/readme-features/design-in-figma.webp" alt="An agent builds an Apple-style mobile landing page in Figma: a black iPhone frame, a white headline, a gray subheading and a blue pill button" width="100%"></p>

In a canvas app the agent works the way a person does: keyboard shortcuts, clicks at a position, and the properties panel by label.

The task, in a browser signed in to Figma: build a one-screen mobile landing page inspired by Apple, with a black iPhone frame, a white headline "Browser CLI", a gray subheading and a blue pill-shaped "Get started" button. A sample of the 63 turns:

```sh
browser click --at 700,300            # the canvas
browser press f                       # frame tool
browser type "Width" 393 --clear
browser press Enter
browser type "Height" 852 --clear
browser press Enter
browser type "Color" 000000 --clear
browser press Enter
browser screenshot -o shots/s5.png    # check the result
```

- `screenshot` lets the agent check each step, and `click --at X,Y` clicks at a point in the viewport.
- For steps a panel does not expose as a field, `browser evaluate --file <script>` runs a short script in the page. This run used small scripts to pick a field and insert text.
- Fields in a properties panel can be named by their label (`"Width"`, `"Color"`), as in a form.
- The run took 63 turns; the clip is shown at 8x. Account details in the clip are blurred.

More: [Driving a page](../guide/driving-a-page.md).
