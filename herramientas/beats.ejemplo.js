/* LOS BEATS DE ESTA JORNADA. Es criterio editorial, no herramienta: vive con el
 * material, igual que el glosario.
 *
 * Exporta una función que recibe `beat` y devuelve la lista de videos.
 *   beat(clip, tiempos, nota, opciones)
 *     clip      número del crudo
 *     tiempos   segundo (o lista de segundos) donde arranca cada frase
 *     nota      por qué se eligió ESTA toma — se imprime en el guion
 *     opciones  { desde, hasta } fuerzan el rango cuando los tiempos de palabra
 *               no son confiables; el script avisa cuándo pasa eso
 */
module.exports = (beat) => {
  return [
  {
    titulo: "Travertino Romano",
    puesta: "showroom · Travertino Romano",
    clips: "17–39",
    beats: [
      beat(18, [3.0, 5.9], "hook — el clip 18 es la toma limpia de 12s; el 17 dice lo mismo en 55s con media charla encima"),
      beat(27, 22.3, "el problema — toma 2 de 2"),
      beat(27, 26.6, "el problema, concretado — toma 3 de 3"),
      beat(27, 71.0, "las demoras del mercado — toma 5 de 5"),
      beat(27, 106.7, "el travertino como clásico — toma 3 de 3"),
      beat(27, 121.3, "dónde funciona — toma 3 de 3"),
      beat(27, 130.2, "PRODUCTO: la más COMPLETA, no la última. La de 196.6s es \"No todo, pero este modelo, el travertino\", un fragmento"),
      beat(27, 139.0, "los tres acabados"),
      beat(21, 0.6, "CTA showroom — toma única y limpia; el 19, 20 y 23 la dicen con tropiezos"),
      beat(25, [26.3, 29.0], "asesoramiento virtual — tomas 4 de 4"),
      beat(26, 24.4, "cierre para comentarios — toma 5 de 5"),
    ],
  },
  {
    titulo: "Portland Greige",
    puesta: "showroom · Portland Greige",
    clips: "29–44",
    beats: [
      beat(29, 11.1, "hook — toma 2 de 2"),
      beat(31, 41.7, "las demoras del mercado — toma 2 de 2, cortada antes del \"bueno, agregué además\"", { hasta: 52.5 }),
      beat(43, 10.5, "PRODUCTO y su origen — toma 3 de 3, la única completa"),
      beat(43, 38.7, "el diseño — toma 2 de 2"),
      beat(44, 1.9, "los formatos grandes — toma limpia; en el 43 quedó a medio decir cuatro veces"),
      beat(44, 23.6, "el acabado mate — toma 2 de 2"),
      beat(44, 34.1, "producción local y stock — la COMPLETA; la de 61.0s es sólo la segunda mitad"),
      beat(33, 21.1, "CTA showroom — toma 2 de 2"),
      beat(34, [12.3, 14.7], "asesoramiento virtual — tomas 2 de 2"),
      beat(34, [26.0, 36.0], "cierre para comentarios"),
    ],
  },
  {
    titulo: "Duomo Gris",
    puesta: "showroom · Duomo Gris",
    clips: "45–54",
    beats: [
      beat(46, 10.7, "hook — el clip 46 es la toma limpia; el 45 tiene cuatro intentos en 68s"),
      beat(54, 16.5, "PRODUCTO — toma 2 de 2"),
      beat(54, 43.0, "formatos grandes y continuidad — toma 2 de 2"),
      beat(54, 85.7, "la textura"),
      beat(54, 108.8, "stock y reposición"),
      beat(54, 143.7, "los 120 años de trayectoria — toma 3 de 3"),
      beat(48, 39.7, "CTA showroom — toma 3 de 3"),
      beat(50, 14.2, "asesoramiento virtual — toma 3 de 3, la que incluye el \"no estás cerca\""),
      beat(51, 9.8, "cierre para comentarios — toma 2 de 2; in y out forzados: las 6 palabras tienen duración CERO y el VAD pone la voz en 9,40–12,30", { desde: 9.35, hasta: 11.95 }),
    ],
  },
  {
    titulo: "London Gris",
    puesta: "showroom · London Gris",
    clips: "55–69",
    beats: [
      beat(55, [13.4, 30.5], "hook — las dos frases en su toma 2 de 2"),
      beat(69, 22.9, "PRODUCTO y la línea — toma 2 de 2"),
      beat(69, 44.5, "el formato alargado — toma 2 de 2"),
      beat(69, 58.3, "la superficie mate — toma 2 de 2"),
      beat(69, 75.9, "alto rendimiento y garage — toma 2 de 2"),
      beat(69, 116.6, "los tonos y con qué combinan — toma 3 de 3"),
      beat(58, 1.9, "CTA showroom — toma única y limpia"),
      beat(59, [48.1, 49.5], "asesoramiento virtual — tomas 4 de 4 y 3 de 3"),
      beat(61, 9.6, "cierre para comentarios — la versión más natural de las dos del 60 y 61"),
    ],
  },
  {
    titulo: "Mesada",
    puesta: "showroom · isla de cocina",
    clips: "70–88",
    beats: [
      beat(70, 10.1, "hook: los mismos modelos con distintos nombres — toma 2 de 2"),
      beat(71, 1.8, "el Terrazo Gris — cortado antes de que repita la frase", { hasta: 22.0 }),
      beat(73, [5.2, 11.7], "el problema y la promesa — toma 2 de 2"),
      beat(78, 1.9, "PRODUCTO: la isla — el clip 78 es la pasada limpia; el 77 dice lo mismo y se corta al final"),
      beat(78, 11.9, "apto alimentos"),
      beat(77, 18.83, "resiste temperatura — del clip 77, no del 78: los tiempos del 78 dicen \"continuo\" pero el audio tiene un titubeo que Whisper colapsó, y sólo se vio al re-transcribir el recorte"),
      beat(78, 48.5, "stock y reposición — toma 3 de 3"),
      beat(74, 9.4, "CTA showroom — toma 2 de 2"),
      beat(75, [9.1, 13.4], "asesoramiento virtual — tomas 2 de 2"),
    ],
  },
  {
    titulo: "Mykonos Gris",
    puesta: "showroom · Mykonos Gris",
    clips: "90–98",
    beats: [
      beat(90, 36.1, "hook — toma 2 de 2"),
      beat(90, 67.7, "la promesa — toma 4 de 4"),
      beat(96, 2.0, "PRODUCTO y su inspiración — el clip 96 es la pasada limpia y entera; el 95 la dice más lenta y suelta"),
      beat(96, 5.2, "texturas y luminosidad"),
      beat(96, 10.9, "stock y planificación"),
      beat(96, 20.1, "las dos terminaciones"),
      beat(96, 29.2, "continuidad visual en toda la casa"),
      beat(92, 0.3, "CTA showroom — toma única y limpia"),
      beat(93, [11.8, 12.6], "asesoramiento virtual — tomas 3 de 3"),
      beat(94, [11.7, 19.6], "cierre para comentarios — tomas 3 de 3 y 4 de 4"),
    ],
  },
  ];
};
