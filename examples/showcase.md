```tikz
\begin{tikzpicture}
  \draw[help lines, step=0.5] (-2.2,-1.4) grid (2.2,1.4);
  \draw[thick, ->] (-2.2,0) -- (2.4,0) node[right] {$x$};
  \draw[thick, ->] (0,-1.4) -- (0,1.6) node[above] {$y$};
  \draw[very thick, blue, domain=-2:2, smooth, samples=60]
    plot (\x, {sin(deg(pi*\x))});
  \node[blue, above] at (1.5,1) {$\sin \pi x$};
\end{tikzpicture}
```

```tikz
\usetikzlibrary{calc}
\begin{document}
\begin{tikzpicture}
  \coordinate (A) at (0,0);
  \coordinate (B) at (4,0);
  \coordinate (C) at (1.2,2.4);
  \draw[thick] (A) -- (B) -- (C) -- cycle;
  \draw[dashed] (C) -- ($(A)!(C)!(B)$) coordinate (H);
  \draw ($(H)+(0.25,0)$) |- ($(H)+(0,0.25)$);
  \node[below left] at (A) {$A$};
  \node[below right] at (B) {$B$};
  \node[above] at (C) {$C$};
  \node[below] at (H) {$H$};
  \node[right] at ($(C)!0.5!(H)$) {$h$};
\end{tikzpicture}
\end{document}
```

```tikz
\documentclass[tikz, border=4pt]{standalone}
\usetikzlibrary{shapes.geometric}
\begin{document}
\begin{tikzpicture}
  \foreach \n/\c [count=\i] in {3/red, 4/orange, 5/teal, 6/blue, 8/violet} {
    \node[regular polygon, regular polygon sides=\n, draw=\c, fill=\c!25,
          thick, minimum size=1.3cm] at (1.7*\i, 0) {\n};
  }
\end{tikzpicture}
\end{document}
```

```tikz
\begin{tikzcd}[row sep=large, column sep=large]
  A \arrow[r, "f"] \arrow[d, "g"'] \arrow[dr, dashed, "h" description] & B \arrow[d, "k"] \\
  C \arrow[r, "l"'] & D
\end{tikzcd}
```

```tikz
\begin{circuitikz}
  \draw (0,0) to[V, v=$V_s$] (0,3)
        to[R, l=$R_1$] (3,3)
        to[C, l=$C$] (3,0) -- (0,0);
  \draw (3,3) -- (5.5,3) to[L, l=$L$] (5.5,0) -- (3,0);
  \draw (0,0) node[ground] {};
\end{circuitikz}
```

```tikz
\pgfplotsset{compat=1.18}
\begin{tikzpicture}
  \begin{axis}[
      width=9cm, height=6cm,
      xlabel={$x$}, ylabel={$y$},
      domain=-3:3, samples=80,
      grid=major, legend pos=north west,
    ]
    \addplot[blue, thick] {exp(-x^2)};
    \addplot[red, thick, dashed] {x^3/9};
    \legend{$e^{-x^2}$, $x^3/9$}
  \end{axis}
\end{tikzpicture}
```

```tikz
\pgfplotsset{compat=1.18}
\begin{tikzpicture}
  \begin{axis}[
      width=9cm, view={35}{30},
      domain=-2:2, y domain=-2:2, samples=25,
      colormap/viridis,
    ]
    \addplot3[mesh] {exp(-x^2-y^2)*x};
  \end{axis}
\end{tikzpicture}
```

```tikz
\chemfig{*6(-=-(-COOH)=(-O-[:30](=[2]O)-[:-30]CH_3)-=)}
```

```tikz
\tdplotsetmaincoords{65}{115}
\begin{tikzpicture}[tdplot_main_coords, scale=2.4]
  \draw[thick, ->] (0,0,0) -- (1.2,0,0) node[anchor=north east] {$x$};
  \draw[thick, ->] (0,0,0) -- (0,1.2,0) node[anchor=north west] {$y$};
  \draw[thick, ->] (0,0,0) -- (0,0,1.2) node[anchor=south] {$z$};
  \tdplotsetcoord{P}{1.1}{50}{55}
  \draw[very thick, red, ->] (0,0,0) -- (P) node[above right] {$\vec{r}$};
  \draw[dashed, red] (0,0,0) -- (Pxy) -- (P);
  \tdplotdrawarc{(0,0,0)}{0.4}{0}{55}{anchor=north}{$\phi$}
  \tdplotsetthetaplanecoords{55}
  \tdplotdrawarc[tdplot_rotated_coords]{(0,0,0)}{0.5}{0}{50}{anchor=south west}{$\theta$}
\end{tikzpicture}
```

```tikz
\usetikzlibrary{positioning, arrows.meta, shapes.geometric}
\begin{tikzpicture}[
    node distance=8mm and 16mm,
    box/.style={draw, rounded corners, thick, fill=blue!10, minimum width=2.6cm, minimum height=8mm},
    test/.style={draw, diamond, aspect=2, thick, fill=orange!20, inner sep=1pt},
    >={Stealth[length=2.5mm]},
  ]
  \node[box] (src) {tikz block};
  \node[test, below=of src] (hit) {cached?};
  \node[box, below=of hit] (tex) {run TeX};
  \node[box, below=of tex] (dvi) {dvisvgm};
  \node[box, right=of dvi] (svg) {show SVG};
  \draw[->, thick] (src) -- (hit);
  \draw[->, thick] (hit) -- node[left] {no} (tex);
  \draw[->, thick] (tex) -- (dvi);
  \draw[->, thick] (dvi) -- (svg);
  \draw[->, thick] (hit) -| node[pos=0.25, above] {yes} (svg);
\end{tikzpicture}
```

```tikz
\usepackage{forest}
\begin{forest}
  for tree={s sep=6mm, l sep=7mm}
  [S
    [NP [Det [the]] [N [plugin]]]
    [VP [V [renders]] [NP [N [diagrams]]]]
  ]
\end{forest}
```

```tikz
\usepackage[dvipsnames]{xcolor}
\begin{tikzpicture}
  \foreach \c [count=\i] in {Maroon, BurntOrange, Goldenrod, ForestGreen, RoyalBlue, Orchid} {
    \fill[\c] (2*\i, 0) circle (0.55);
    \node[below, font=\footnotesize] at (2*\i, -0.65) {\c};
  }
\end{tikzpicture}
```

```tikz
\usetikzlibrary{automata, positioning, arrows.meta}
\begin{tikzpicture}[node distance=2.4cm, on grid, auto, >={Stealth}, thick]
  \node[state, initial] (q0) {$q_0$};
  \node[state, right=of q0] (q1) {$q_1$};
  \node[state, accepting, right=of q1] (q2) {$q_2$};
  \path[->] (q0) edge[loop above] node {0} ()
                 edge node {1} (q1)
            (q1) edge[bend left] node {0} (q2)
                 edge[loop above] node {1} ()
            (q2) edge[bend left] node {1} (q1);
\end{tikzpicture}
```

```tikz
\usetikzlibrary{decorations.pathreplacing, decorations.pathmorphing, arrows.meta}
\begin{tikzpicture}
  \fill[red, opacity=0.45] (0,0) circle (1);
  \fill[green!70!black, opacity=0.45] (1,0) circle (1);
  \fill[blue, opacity=0.45] (0.5,0.87) circle (1);
  \draw[decorate, decoration={brace, amplitude=6pt, mirror}]
    (-1,-1.2) -- (2,-1.2) node[midway, below=7pt] {opacity};
  \draw[thick, -{Latex[length=3mm]}, decorate, decoration={snake, amplitude=1.5pt, post length=4mm}]
    (2.8,0.4) -- (5.2,0.4) node[midway, above=3pt] {snake};
  \draw[thick, {Circle[open]}-{Triangle[open]}] (2.8,-0.4) -- (5.2,-0.4)
    node[midway, below] {arrows.meta};
\end{tikzpicture}
```

```tikz
\begin{tikzpicture}
  \foreach \c [count=\i] in {black, red, orange, yellow, green, blue, violet} {
    \fill[\c] (\i, 0) rectangle +(0.85, 0.85);
    \draw[\c, very thick] (\i, -0.5) -- +(0.85, 0);
  }
  \node[right] at (1, -1.1) {black text and lines flip to light};
\end{tikzpicture}
```

```tikz
\usetikzlibrary{backgrounds}
\begin{tikzpicture}[
    show background rectangle,
    background rectangle/.style={fill=white, draw=none},
  ]
  \foreach \c [count=\i] in {black, red, orange, yellow, green, blue, violet} {
    \fill[\c] (\i, 0) rectangle +(0.85, 0.85);
  }
  \node[right] at (1, -0.5) {always on white};
\end{tikzpicture}
```
