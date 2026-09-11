/* LOS BEATS DE UNA JORNADA. Es criterio editorial, no herramienta: vive con el
 * material, igual que el glosario.
 *
 * Exporta una función que recibe `beat` y devuelve la lista de videos.
 *   beat(clip, tiempos, nota, opciones)
 *     clip      número del crudo
 *     tiempos   segundo (o lista de segundos) donde arranca cada frase
 *     nota      por qué se eligió ESTA toma — se imprime en el guion
 *     opciones  { desde, hasta } fuerzan el rango cuando los tiempos de palabra
 *               no son confiables; el script avisa cuándo pasa eso
 *
 * ── LAS NOTAS SON LA MITAD DEL VALOR ──
 *
 * No son decoración: se imprimen en el guion, así que cuando el corte sale raro
 * dicen POR QUÉ se eligió cada toma, y eso permite discutirlo sin volver a mirar
 * los crudos enteros. Las tres que más se repiten en una jornada real:
 *
 *   "toma N de N"          la última, que suele ser la buena DENTRO de un clip
 *   "la más COMPLETA"      y NO la última: a veces la mejor es una del medio
 *   "toma única y limpia"  no hay con qué comparar, y conviene saberlo
 *
 * Este archivo es un EJEMPLO con contenido inventado. El de verdad vive al lado
 * del material del proyecto, nunca en este repo.
 */
module.exports = (beat) => {
  return [
  {
    titulo: "Producto A",
    puesta: "sala · Producto A",
    clips: "17–39",
    beats: [
      beat(18, [3.0, 5.9], "hook — el clip 18 es la toma limpia de 12s; el 17 dice lo mismo en 55s con media charla encima"),
      beat(27, 22.3, "el problema — toma 2 de 2"),
      beat(27, 71.0, "las demoras — toma 5 de 5"),
      beat(27, 130.2, "PRODUCTO: la más COMPLETA, no la última. La de 196.6s arranca por el medio de la frase"),
      beat(27, 139.0, "los tres acabados"),
      beat(21, 0.6, "CTA — toma única y limpia; el 19, 20 y 23 la dicen con tropiezos"),
      beat(25, [26.3, 29.0], "asesoramiento — tomas 4 de 4"),
      beat(26, 24.4, "cierre para comentarios — toma 5 de 5"),
    ],
  },
  {
    titulo: "Producto B",
    puesta: "sala · Producto B",
    clips: "29–44",
    beats: [
      beat(29, 11.1, "hook — toma 2 de 2"),
      beat(31, 41.7, "las demoras — toma 2 de 2, cortada antes del \"bueno, agregué además\"", { hasta: 52.5 }),
      beat(43, 10.5, "PRODUCTO y su origen — toma 3 de 3, la única completa"),
      beat(43, 38.7, "el diseño — toma 2 de 2"),
      /* Cuando los tiempos de palabra no son confiables —porque la frase arranca
         pegada a la anterior— se fuerza el rango entero y el script lo informa. */
      beat(44, 9.6, "la terminación — el rango va a mano: la transcripción parte la frase en dos", { desde: 9.35, hasta: 11.95 }),
      beat(33, 1.2, "CTA — toma única"),
      beat(34, [8.4, 15.0], "cierre — tomas 3 de 3 y 4 de 4"),
    ],
  },
  {
    titulo: "Producto C",
    puesta: "sala · Producto C",
    clips: "90–98",
    beats: [
      beat(90, 36.1, "hook — toma 2 de 2"),
      beat(90, 67.7, "la promesa — toma 4 de 4"),
      beat(96, 2.0, "PRODUCTO y su inspiración — el clip 96 es la pasada limpia y entera; el 95 la dice más lenta y suelta"),
      beat(96, 10.9, "stock y planificación"),
      beat(96, 29.2, "continuidad visual"),
      beat(92, 0.3, "CTA — toma única y limpia"),
      beat(93, [11.8, 12.6], "asesoramiento — tomas 3 de 3"),
      beat(94, [11.7, 19.6], "cierre para comentarios — tomas 3 de 3 y 4 de 4"),
    ],
  },
  ];
};
