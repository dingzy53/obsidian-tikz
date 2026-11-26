# Deep surface and two-page block

A 30-sample pgfplots surface: its raw SVG nests thousands of groups.

```tikz
\begin{tikzpicture}
\begin{axis}
\addplot3[surf, samples=30, opacity=0.9, domain=-2:2] {exp(-x^2-y^2)};
\end{axis}
\end{tikzpicture}
```

Two pictures in one `[tikz]` standalone document: two pages.

```tikz
\documentclass[tikz]{standalone}
\begin{document}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}
\end{document}
```
