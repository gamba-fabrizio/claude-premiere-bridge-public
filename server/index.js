#!/usr/bin/env node
/**
 * Servidor MCP del bridge: expone Premiere como herramientas de Claude.
 *
 * El servidor no sabe nada de Premiere. Traduce llamadas MCP a comandos en la
 * carpeta compartida y devuelve lo que contesta el panel. Toda la lógica de la
 * API vive del lado del plugin, que es el único que puede tocarla.
 *
 * Los verbos son CHICOS y operan sobre cosas que ya existen. La tentación es
 * exponer un "ejecutá este JS", y sería un error: la API de Premiere falla en
 * silencio —devuelve éxito y no hace nada— así que un verbo genérico produce
 * código plausible que no pasó. Cada verbo de acá devuelve QUÉ ENCONTRÓ, no un
 * ok, para que se pueda verificar por efecto observable.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { enviar } = require("./bridge.js");

const server = new McpServer({ name: "premiere-bridge", version: "0.1.0" });

/** Respuesta de texto, con el objeto entero abajo para no perder contexto. */
function texto(resumen, datos) {
  const partes = [resumen];
  if (datos) partes.push("\n" + JSON.stringify(datos, null, 2));
  return { content: [{ type: "text", text: partes.join("") }] };
}

function fallo(e) {
  return {
    isError: true,
    content: [{ type: "text", text: e && e.message ? e.message : String(e) }]
  };
}

/* ---------- leer ---------- */

server.registerTool(
  "premiere_estado",
  {
    title: "Estado de la secuencia",
    description:
      "Qué hay abierto en Premiere ahora mismo: secuencia activa, medida, fps, " +
      "cuántas pistas de video, y qué clip está seleccionado (con su pista). " +
      "Empezá por acá: el resto de las herramientas operan sobre el clip seleccionado, " +
      "así que sin esto estás escribiendo a ciegas.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async ({ proyecto, secuencia }) => {
    try {
      const r = await enviar("estado", { proyecto, secuencia });
      return texto(r.resumen, r.info);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_frame",
  {
    title: "Ver el frame bajo el playhead",
    description:
      "Exporta el cuadro que está bajo el playhead y lo devuelve como imagen, " +
      "para poder MIRAR el resultado en vez de deducirlo de los números. " +
      "Usalo después de aplicar un cambio, para confirmar que quedó como se esperaba.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      ancho: z
        .number()
        .int()
        .min(160)
        .max(1920)
        .optional()
        .describe("Ancho del frame en píxeles. Por defecto 960. El alto sale de la proporción de la secuencia.")
    }
  },
  async ({ ancho, proyecto, secuencia }) => {
    try {
      const r = await enviar("frame", { ancho: ancho || 960, proyecto, secuencia }, 60000);
      return {
        content: [
          { type: "text", text: r.resumen },
          { type: "image", data: r.pngBase64, mimeType: "image/png" }
        ]
      };
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_vistazo",
  {
    title: "Ver de qué es el material",
    description:
      "Devuelve varios cuadros repartidos por la secuencia, para reconocer de qué se trata: " +
      "el escenario, quién aparece, si hay gráficos en pantalla, dónde cambia el contenido.\n\n" +
      "Son FOTOS SUELTAS, no video: un plano fijo y una cámara que volvió al mismo encuadre se " +
      "ven igual, y lo que pasa entre dos muestras no se ve. No sirve para detectar cortes con " +
      "precisión ni para juzgar movimiento, y no hay audio.\n\n" +
      "Cada cuadro cuesta una exportación y una imagen entera de contexto: pedí los que hagan " +
      "falta, no el máximo por las dudas. Deja el playhead donde estaba.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      cuantos: z.number().int().min(2).max(12).optional().describe("Cuántos cuadros. Por defecto 6, tope 12."),
      desde: z.number().min(0).optional().describe("Segundo donde empezar a muestrear. Por defecto 0."),
      hasta: z.number().min(0).optional().describe("Segundo donde terminar. Por defecto el final de la secuencia."),
      ancho: z.number().int().min(160).max(640).optional().describe("Ancho de cada cuadro. Por defecto 280.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("vistazo", args, 180000);
      const content = [{ type: "text", text: r.resumen }];
      for (const c of r.cuadros) {
        content.push({ type: "text", text: `${c.segundos}s` });
        content.push({ type: "image", data: c.pngBase64, mimeType: "image/png" });
      }
      return { content };
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_analizar",
  {
    title: "Qué pasa en el video: imagen y texto juntos",
    description:
      "Devuelve cuadros repartidos por el material, y con CADA UNO lo que se dice en ese " +
      "momento. Es la herramienta para \"contame de qué es esto\".\n\n" +
      "Las dos fuentes dicen cosas distintas, no la misma dos veces: en un caso real las " +
      "imágenes mostraban un taller de arte y el texto reveló que era una publicidad de " +
      "porcelanato, con marca y artista. Con los cuadros solos la descripción salía bien del " +
      "lugar y mal del video. **Leé las dos.**\n\n" +
      "Necesita que el material YA esté transcripto (panel Text de Premiere; la API no puede " +
      "dispararlo). Con `medio` no hace falta que esté en ninguna secuencia: monta una " +
      "temporal, saca los cuadros y la borra.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().optional().describe("Nombre de un medio del panel de proyecto. Sin esto, el clip seleccionado en el timeline."),
      cuantos: z.number().int().min(2).max(12).optional().describe("Cuántos cuadros. Por defecto 6, tope 12."),
      ancho: z.number().int().min(160).max(640).optional().describe("Ancho de cada cuadro. Por defecto 280.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("analizar", args, 240000);
      const content = [{ type: "text", text: r.resumen }];
      for (const c of r.cuadros) {
        content.push({ type: "text", text: `\n${c.segundos}s — se dice: "${c.dice}"` });
        content.push({ type: "image", data: c.pngBase64, mimeType: "image/png" });
      }
      return { content };
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_motion",
  {
    title: "Leer el Motion del clip seleccionado",
    description:
      "Position, Scale y Scale Width del efecto Motion del clip seleccionado, " +
      "con la cantidad de keyframes de cada uno. Motion es intrínseco: está en " +
      "todos los clips y no hay que insertarlo.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async ({ proyecto, secuencia }) => {
    try {
      const r = await enviar("motion", { proyecto, secuencia });
      return texto(r.resumen, r.params);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_efectos",
  {
    title: "Los efectos del clip y sus params",
    description:
      "Lista los efectos del clip seleccionado con los nombres EXACTOS de sus parámetros. " +
      "Empezá por acá antes de leer o escribir cualquier param: los nombres de esta API no " +
      "son adivinables (el Gaussian Blur se llama \"Gaussian Blur (Legacy)\", Motion expone " +
      "\"Scale\" y \"Scale Width\" pero no \"Scale Height\", y el efecto Transform al revés).",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async ({ proyecto, secuencia }) => {
    try {
      const r = await enviar("efectos", { proyecto, secuencia });
      return texto(r.resumen, r.efectos);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_catalogo",
  {
    title: "Buscar entre los efectos instalados",
    description:
      "Busca en los efectos de video instalados y devuelve su nombre visible junto con su " +
      "match name. Usalo antes de premiere_agregar_efecto.\n\n" +
      "Los nombres engañan y por eso este verbo existe: el Gaussian Blur de Adobe figura como " +
      "\"Gaussian Blur (Legacy)\", y puede haber un \"Gaussian Blur\" a secas que es de un " +
      "tercero y hace otra cosa.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      buscar: z
        .string()
        .optional()
        .describe("Texto a buscar en el nombre o el match name. Sin esto son cientos y se recorta.")
    }
  },
  async ({ buscar, proyecto, secuencia }) => {
    try {
      const r = await enviar("catalogo", { buscar, proyecto, secuencia });
      return texto(r.resumen, r.efectos);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_agregar_efecto",
  {
    title: "Agregar un efecto al clip",
    description:
      "Le agrega un efecto de video al clip seleccionado, por nombre visible o por match name. " +
      "Devuelve la lista de efectos ANTES y DESPUÉS, y los params del efecto nuevo — que es lo " +
      "que hace falta para después escribirle valores con premiere_keyframe.\n\n" +
      "Si el nombre es ambiguo no elige por su cuenta: lista los candidatos y falla.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      efecto: z
        .string()
        .describe("Nombre visible (ej: \"Lumetri Color\") o match name (ej: \"AE.ADBE Lumetri\").")
    }
  },
  async ({ efecto, proyecto, secuencia }) => {
    try {
      const r = await enviar("agregarEfecto", { efecto, proyecto, secuencia });
      return texto(r.resumen, { antes: r.efectosAntes, despues: r.efectosDespues, params: r.params });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_param",
  {
    title: "Leer un param de un efecto",
    description:
      "El valor de un parámetro en el playhead, más en qué segundos tiene keyframes. " +
      "Los tiempos vienen en segundos de la SECUENCIA, que es el reloj del timeline.\n\n" +
      "SOLO LEE. Para escribir: `premiere_fijar` pone un valor fijo —lo que se quiere casi " +
      "siempre— y `premiere_keyframe` agrega uno en el playhead, o sea que anima.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      param: z.string().describe("Nombre exacto del param, de premiere_efectos."),
      efecto: z.string().optional().describe("Nombre del efecto. Por defecto \"Motion\"."),
      nombre: z.string().optional().describe("Parte del nombre del clip. Sin nada, el seleccionado."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Etiqueta de pista: \"V2\", \"A1\"."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("param", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_transcripcion",
  {
    title: "Leer la transcripción de un clip",
    description:
      "La transcripción del clip, con los tiempos convertidos a segundos de la SECUENCIA — " +
      "listos para pasárselos a premiere_playhead o premiere_editar.\n\n" +
      "Sin argumentos devuelve el texto completo y los segmentos. Con `buscar` devuelve solo " +
      "dónde aparece esa palabra, que es lo que sirve para ir a un punto sin traerse todo. " +
      "Con `palabras: true` agrega el tiempo de CADA palabra, para cortes finos.\n\n" +
      "OJO: la API puede leer transcripciones pero NO crearlas. Si el clip no tiene, hay que " +
      "transcribirlo a mano en Premiere (panel Text > Transcribe).\n\n" +
      "Las palabras marcadas como recortadas caen fuera del clip: están en el material pero no " +
      "en el timeline, así que no se puede cortar ahí.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z
        .string()
        .optional()
        .describe("Nombre de un medio del PANEL DE PROYECTO. No necesita estar en ninguna secuencia; los tiempos salen en fuente."),
      nombre: z.string().optional().describe("Parte del nombre del clip en el timeline. Sin nada, el seleccionado."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Etiqueta de pista: \"V2\", \"A1\"."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista."),
      buscar: z.string().optional().describe("Devolver solo las apariciones de este texto, con su segundo."),
      palabras: z.boolean().optional().describe("true agrega el tiempo de cada palabra. Son cientos: pedilo solo si hace falta."),
      crudo: z
        .boolean()
        .optional()
        .describe(
          "true devuelve el ESQUEMA del JSON de Premiere en vez del texto: las claves, un segmento " +
          "de muestra y los idiomas soportados. Sirve para armar un JSON importable, porque " +
          "`ppro.Transcript` también expone `importFromJSON`: se puede transcribir afuera de " +
          "Premiere e inyectarlo."
        )
    }
  },
  async (args) => {
    try {
      const r = await enviar("transcripcion", args, 60000);
      return texto(r.resumen, r.coincidencias || r.segmentos);
    } catch (e) {
      return fallo(e);
    }
  }
);

/* ---------- navegar ---------- */

server.registerTool(
  "premiere_clips",
  {
    title: "Listar los clips de la secuencia",
    description:
      "Todos los clips de video con su pista, índice, nombre y tiempos en segundos. " +
      "Es lo que permite trabajar sobre la secuencia entera en vez de solo sobre lo " +
      "que el usuario tenga seleccionado.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Limitar a una pista, numerada como en el timeline: 1 es V1. Sin esto, todas.")
    }
  },
  async ({ pista, proyecto, secuencia }) => {
    try {
      const r = await enviar("clips", { pista, proyecto, secuencia });
      return texto(r.resumen, r.clips);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_playhead",
  {
    title: "Leer o mover el playhead",
    description:
      "Sin argumentos devuelve dónde está el playhead, en segundos. Con `segundos` lo " +
      "mueve. Mover el playhead y después pedir `premiere_frame` es la forma de mirar " +
      "otro momento de la secuencia.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      segundos: z
        .number()
        .min(0)
        .optional()
        .describe("A qué segundo de la SECUENCIA mover el playhead. Sin esto, solo lee.")
    }
  },
  async ({ segundos, proyecto, secuencia }) => {
    try {
      const r = await enviar("playhead", { segundos, proyecto, secuencia });
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_seleccionar",
  {
    title: "Seleccionar un clip",
    description:
      "Selecciona un clip en el timeline, por nombre (coincidencia parcial) o por pista " +
      "e índice de `premiere_clips`. El resto de las herramientas operan sobre el clip " +
      "seleccionado, así que esto es lo que permite pasar de uno a otro sin tocar el mouse. " +
      "Confirma releyendo la selección: si no quedó, lo dice.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Parte del nombre del clip. No distingue mayúsculas."),
      pista: z.number().int().min(1).optional().describe("Pista como en el timeline: 1 es V1."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista, de premiere_clips.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("seleccionar", args);
      return texto(r.resumen, r.pedido);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_armar_secuencia",
  {
    title: "Armar una secuencia con fragmentos de un medio",
    description:
      "Crea una secuencia nueva y le pega, uno atrás del otro, los fragmentos que se le pidan. " +
      "Los fragmentos pueden salir de MEDIOS DISTINTOS: cada uno nombra el suyo, o heredan el " +
      "`medio` general si todos vienen del mismo. " +
      "Es lo que convierte \"cortame las partes donde habla de X\" en algo ejecutable: " +
      "premiere_transcripcion da los tiempos, esto los corta y los pega.\n\n" +
      "**Los tiempos son de FUENTE**: los campos `desdeFuente` y `hastaFuente` de " +
      "premiere_transcripcion, NO los de secuencia. Pasarle los otros arma un corte equivocado " +
      "sin avisar.\n\n" +
      "El audio vinculado del medio viene solo y alineado. Los cortes se pegan al frame, así que " +
      "pueden arrancar hasta un frame antes de lo pedido.\n\n" +
      "**La secuencia hereda tamaño y fps del material**, que con una cámara vertical moderna son " +
      "2160x3840 @ 50fps. Con `ancho`/`alto`/`fps` se pide otra cosa, y se aplica con la " +
      "secuencia todavía VACÍA: así los cortes snapean al frame que va desde el principio. " +
      "Pedirlo después con premiere_resolucion puede dejar cortes entre frames.\n\n" +
      "**Para los fps, lo que anda seguro es `preset`**: una ruta a un `.sqpreset`, que trae los " +
      "fps y el modo de edición juntos. `setVideoFrameRate` rechazó el valor en la prueba del " +
      "2026-08-17 —con el número correcto, el mismo que trae un preset de fábrica— así que " +
      "`fps` se intenta pero puede no entrar; el verbo dice qué pasó. Premiere trae presets en " +
      "`Contents/Settings/SequencePresets` dentro del bundle de la app, incluido uno vertical " +
      "1080x1920, y un `.sqpreset` es XML: se copia y se le cambia `VideoFrameRate` (ticks por " +
      "frame: 254016000000/fps), `VideoFrameSize` y `VideoTimeDisplay`.\n\n" +
      "Devuelve dónde quedó cada fragmento y cuáles fallaron, si alguno falló.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().optional().describe("Medio por defecto, si todos los fragmentos salen del mismo."),
      nombre: z.string().optional().describe("Nombre de la secuencia nueva. Por defecto \"Corte\"."),
      preset: z.string().optional().describe("Ruta absoluta a un .sqpreset. Es la forma confiable de fijar los fps; la secuencia nace con los ajustes del preset en vez de heredar los del material."),
      ancho: z.number().int().min(16).optional().describe("Ancho del cuadro en píxeles, si no se quiere el del material. Va con `alto`."),
      alto: z.number().int().min(16).optional().describe("Alto del cuadro en píxeles. Va con `ancho`."),
      fps: z.number().min(1).max(240).optional().describe("Cuadros por segundo, si no se quieren los del material. Puede no entrar: usá `preset` si es crítico."),
      fragmentos: z
        .array(z.object({
          medio: z.string().optional().describe("De qué medio sale este fragmento. Sin esto, el `medio` general."),
          desde: z.number().min(0).describe("Segundo de la FUENTE donde arranca el fragmento."),
          hasta: z.number().min(0).describe("Segundo de la FUENTE donde termina.")
        }))
        .min(1)
        .describe("Los pedazos a pegar, en orden. Pueden salir de medios distintos."),
      capas: z
        .array(z.object({
          medio: z.string().describe("Medio a poner (ej: \"Transparent Video\")."),
          pista: z.number().int().min(1).optional().describe("Pista de video. Por defecto V2."),
          en: z.number().min(0).describe("Segundo de la SECUENCIA NUEVA donde arranca."),
          desde: z.number().min(0).optional().describe("Segundo de la FUENTE donde empieza el pedazo. Por defecto 0, que sirve para un generador pero no para un pedazo concreto de un clip real."),
          dura: z.number().min(0).describe("Cuánto dura, en segundos."),
          nombre: z.string().optional().describe("Renombra el clip puesto, para rotular qué es sin tener que abrirlo."),
          apagado: z.boolean().optional().describe("Lo deja apagado: ocupa lugar en la pista y no se ve. Sirve para dejar tomas alternativas a mano sin que tapen al titular.")
        }))
        .optional()
        .describe("Medios en posiciones explícitas: capas de anotación, o una pista de tomas alternativas apagadas sobre el corte.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("armarSecuencia", args, 180000);
      return texto(r.resumen, { puestos: r.puestos, capasPuestas: r.capasPuestas, fallidos: r.fallidos, capasFallidas: r.capasFallidas, duracion: r.duracionTotal, reajuste: r.reajuste, inOutLimpiados: r.inOutLimpiados });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_borrar_secuencia",
  {
    title: "Borrar una secuencia del proyecto",
    description:
      "Saca una secuencia entera del proyecto, por nombre. Verifica contando las secuencias " +
      "antes y después; si no bajó, lo dice. Esto NO se deshace con Cmd+Z de forma confiable: " +
      "pedí confirmación antes de usarlo sobre algo que no creó el bridge.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().describe("Parte del nombre de la secuencia a borrar.")
    }
  },
  async ({ nombre, proyecto, secuencia }) => {
    try {
      const r = await enviar("borrarSecuencia", { nombre, proyecto, secuencia });
      return texto(r.resumen, { borrada: r.borrada, quedan: r.quedan });
    } catch (e) {
      return fallo(e);
    }
  }
);

/* ---------- el panel de proyecto ---------- */

server.registerTool(
  "premiere_medios",
  {
    title: "Qué hay en el panel de proyecto",
    description:
      "Lista los medios del proyecto con el bin donde vive cada uno, recorriendo las carpetas. " +
      "Es de dónde salen los nombres para premiere_insertar.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      buscar: z.string().optional().describe("Filtra por nombre. Sin esto puede ser una lista larga.")
    }
  },
  async ({ buscar, proyecto, secuencia }) => {
    try {
      const r = await enviar("medios", { buscar, proyecto, secuencia });
      return texto(r.resumen, r.medios);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_secuencias",
  {
    title: "Listar secuencias o cambiar la activa",
    description:
      "Sin argumentos lista las secuencias del proyecto y dice cuál está activa. Con `nombre` " +
      "cambia a esa. Todas las demás herramientas trabajan sobre la secuencia activa, así que " +
      "esto es lo que permite pasar de una a otra.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Parte del nombre de la secuencia a activar. Sin esto, solo lista.")
    }
  },
  async ({ nombre, proyecto, secuencia }) => {
    try {
      const r = await enviar("secuencias", { nombre, proyecto, secuencia });
      return texto(r.resumen, { secuencias: r.secuencias, activa: r.activa });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_borrar",
  {
    title: "Sacar un clip del timeline",
    description:
      "Saca un clip, por nombre o por pista+índice. Es el inverso de premiere_insertar.\n\n" +
      "Por defecto DEJA EL HUECO: no mueve nada más. Con `dejarHueco: false` hace ripple y corre " +
      "todo lo que está a la derecha — eso descoloca cualquier cosa alineada con el clip, así que " +
      "usalo solo si el usuario lo pidió.\n\n" +
      "Verifica contando los clips de la pista antes y después; si no bajó, falla.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Parte del nombre del clip."),
      pista: z
        .union([z.number().int().min(1), z.string()])
        .optional()
        .describe("La etiqueta que devuelve premiere_clips: \"V2\", \"A1\". Un número se lee como pista de video."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista, de premiere_clips."),
      dejarHueco: z
        .boolean()
        .optional()
        .describe("true (el default) saca el clip y no mueve nada. false hace ripple.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("borrar", args);
      return texto(r.resumen, { clipsAntes: r.clipsAntes, clipsDespues: r.clipsDespues });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_insertar",
  {
    title: "Poner un medio en el timeline",
    description:
      "Pone un medio del proyecto en una pista de video, en el segundo que se indique.\n\n" +
      "PISA lo que haya en esa zona de la pista (overwrite), no empuja el resto. Es a propósito: " +
      "insertar corriendo todo lo que está a la derecha es un cambio grande y difícil de ver " +
      "desde acá. Poné en una pista libre si no querés pisar nada — premiere_clips dice cuáles " +
      "están ocupadas.\n\n" +
      "Devuelve cuántos clips tenía la pista antes y después, y dónde quedó el nuevo.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().describe("Nombre del medio, de premiere_medios. Coincidencia parcial."),
      pista: z.number().int().min(1).optional().describe("Pista como en el timeline: 1 es V1. Por defecto V1."),
      pistaAudio: z.number().int().min(1).optional().describe("Pista de audio. Por defecto espeja la de video: insertar en V3 manda el audio a A3. Con A1 fijo, el audio PISA lo que haya ahí."),
      segundos: z.number().min(0).optional().describe("Dónde arranca, en segundos. Por defecto el playhead.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("insertar", args);
      return texto(r.resumen, { clipsAntes: r.clipsAntes, clipsDespues: r.clipsDespues, puesto: r.puesto });
    } catch (e) {
      return fallo(e);
    }
  }
);

/* ---------- editar el timeline ---------- */

server.registerTool(
  "premiere_editar",
  {
    title: "Mover, recortar o apagar un clip",
    description:
      "Cambia la posición de un clip en el timeline, su punto de entrada o salida, o lo apaga. " +
      "El clip se nombra explícitamente (por nombre o pista+índice), NO se usa el seleccionado: " +
      "mover algo que el usuario no ve seleccionado es una sorpresa fea.\n\n" +
      "OJO con `entrada`: recortar la entrada también corre el arranque del clip en la secuencia, " +
      "igual que arrastrar su borde izquierdo. Para dejarlo donde está y cambiar solo qué parte de " +
      "la fuente se ve, no existe una acción directa.\n\n" +
      "Todo entra en una transacción (un Cmd+Z) y devuelve los tiempos ANTES y DESPUÉS: si no " +
      "cambió nada, lo dice.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Parte del nombre del clip."),
      pista: z
        .union([z.number().int().min(1), z.string()])
        .optional()
        .describe("La etiqueta que devuelve premiere_clips: \"V2\", \"A1\". Un número se lee como pista de video."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista, de premiere_clips."),
      desde: z.number().min(0).optional().describe("Mover el clip para que arranque en este segundo de la secuencia."),
      entrada: z.number().min(0).optional().describe("Punto de entrada, en segundos dentro de la fuente."),
      salida: z.number().min(0).optional().describe("Punto de salida, en segundos dentro de la fuente."),
      apagado: z.boolean().optional().describe("true lo apaga (sigue en el timeline pero no se ve).")
    }
  },
  async (args) => {
    try {
      const r = await enviar("editar", args);
      return texto(r.resumen, { antes: r.antes, despues: r.despues, cambio: r.cambio });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_cortar",
  {
    title: "Partir un clip en dos",
    description:
      "Parte un clip en un segundo de la secuencia. La API NO tiene razor, así que se emula: " +
      "se recorta la salida del clip hasta ahí y se reinserta el mismo medio con la entrada " +
      "corrida. El resultado es indistinguible de un corte, y el audio vinculado se parte igual.\n\n" +
      "Casi siempre conviene premiere_sacar_rangos, que hace los dos cortes y el borrado. Este " +
      "verbo es el atómico, para cuando hace falta partir sin sacar nada.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      segundos: z.number().min(0).describe("Segundo de la SECUENCIA donde partir."),
      nombre: z.string().optional().describe("Parte del nombre del clip."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Etiqueta de pista: \"V1\", \"A1\"."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista, de premiere_clips.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("cortar", args, 120000);
      return texto(r.resumen, { partes: r.partes, pegados: r.pegados });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_sacar_rangos",
  {
    title: "Sacar tramos de la secuencia cerrando el hueco",
    description:
      "Saca uno o varios rangos de tiempo y corre lo que queda a la izquierda (ripple). Es lo que " +
      "permite editar EN LA SECUENCIA en vez de reconstruirla, así que respeta todo lo que el " +
      "usuario haya editado a mano.\n\n" +
      "Los rangos se procesan del último al primero por su cuenta: cada ripple corre los tiempos " +
      "de la derecha, así que ir de adelante para atrás invalidaría los rangos siguientes. Se " +
      "pasan en tiempos de la secuencia ACTUAL, sin compensar nada.\n\n" +
      "Un rango que cruza de un clip a otro no se toca y se informa. Devuelve cuánto se fue de " +
      "verdad contra cuánto se pidió: si no coinciden, algo salió distinto de lo esperado.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      rangos: z
        .array(z.object({
          desde: z.number().min(0).describe("Segundo de la secuencia donde arranca el tramo a sacar."),
          hasta: z.number().min(0).describe("Segundo donde termina.")
        }))
        .min(1)
        .describe("Los tramos a sacar. El orden no importa."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Pista sobre la que operar. Por defecto V1.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("sacarRangos", args, 600000);
      return texto(r.resumen, { hechos: r.hechos, fallidos: r.fallidos, sacado: r.sacadoReal });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_cerrar_huecos",
  {
    title: "Cerrar huecos de un frame entre clips",
    description:
      "Cierra los huecos chicos entre clips estirando el clip anterior. Los cortes emulados " +
      "dejan juntas de un frame —el recorte ajusta el final a un frame y la reinserción ajusta " +
      "el inicio a otro— y en una pista de video eso es un parpadeo negro.\n\n" +
      "Estira el clip ANTERIOR en vez de mover el siguiente: mover arrastraría todo lo de la " +
      "derecha y desalinearía las capas de anotación. Estirar muestra uno o dos frames más del " +
      "material, que es invisible.\n\n" +
      "Corré esto después de premiere_sacar_rangos si notás parpadeos.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Pista a revisar. Por defecto V1."),
      tope: z.number().min(0).optional().describe("Hueco máximo a cerrar, en segundos. Por defecto 0.25.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("cerrarHuecos", args, 300000);
      return texto(r.resumen, { cerrados: r.cerrados, quedan: r.quedan });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_resolucion",
  {
    title: "Cambiar el tamaño y los fps de la secuencia",
    description:
      "Cambia el tamaño de cuadro y/o los fps de la secuencia activa. Se puede pedir uno solo " +
      "de los dos.\n\n" +
      "**NO reescala los clips**: material 4K en una secuencia 1080 entra al 100% de Motion, " +
      "que son píxeles 1:1, así que se ve el CENTRO del cuadro y el resto queda afuera. No hay " +
      "franjas ni error, se ve mal y nada lo dice. Ajustalo después con premiere_escala.\n\n" +
      "**Y si cambiás los fps con clips ya puestos**, los cortes que caían en un frame de los " +
      "viejos pueden quedar ENTRE frames de los nuevos: corré premiere_revisar, que mide los " +
      "huecos en frames. Para una secuencia nueva es mejor pedir el tamaño y los fps " +
      "directamente en premiere_armar_secuencia, que los aplica con la secuencia todavía vacía.\n\n" +
      "Devuelve el antes y el después de las dos cosas, y por qué forma entró cada una.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      ancho: z.number().int().min(16).optional().describe("Ancho en píxeles. Va junto con `alto`."),
      alto: z.number().int().min(16).optional().describe("Alto en píxeles. Va junto con `ancho`."),
      fps: z.number().min(1).max(240).optional().describe("Cuadros por segundo, por ejemplo 25 o 29.97.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("resolucion", args, 120000);
      return texto(r.resumen, { antes: r.antes, despues: r.despues, fpsSegunGetTimebase: r.fpsSegunGetTimebase });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_escala",
  {
    title: "Fijar la escala del Motion en todos los clips",
    description:
      "Pone un valor de escala fijo —sin keyframes— en el Motion de todos los clips de la " +
      "secuencia. Es lo que hace \"Set to Frame Size\": con material del doble del cuadro, el " +
      "ajuste es 50.\n\n" +
      "Se aplica por CLIP, así que no toca ese material en otras secuencias. Contempla que el " +
      "param se llame \"Scale\" o \"Scale Height\" según la casilla Uniform Scale.",
    inputSchema: {
      limite: z.number().int().min(1).optional().describe(
        "Cuantos clips tocar en esta llamada. Default 30. Existe porque este verbo hace una "
        + "lectura de valor POR CLIP —el regimen que tiro Premiere— y 32 clips de 4K a 50fps lo "
        + "mataron donde 35 verticales habian pasado: la variable es el PESO del material."
      ),
      desdeIndice: z.number().int().min(0).optional().describe(
        "Desde que clip seguir. Sale de `siguiente` en la respuesta anterior; el resumen avisa "
        + "cuando quedo a medias."
      ),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      valor: z.number().optional().describe("Porcentaje de escala. Por defecto 50."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Limitar a una pista, ej \"V1\". Sin esto, todas.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("escalaFija", args, 600000);
      return texto(r.resumen, { hechos: r.hechos, total: r.total, via: r.via });
    } catch (e) {
      return fallo(e);
    }
  }
);

/* ---------- escribir ---------- */

const PUNTO = z.object({
  segundos: z.number().min(0).optional().describe("Segundo de la SECUENCIA. Sin esto, el playhead."),
  valor: z.union([z.number(), z.boolean()]).optional().describe("Para params numéricos o de casilla."),
  x: z.number().optional().describe("Para params de punto: fracción horizontal (0.5 es el centro)."),
  y: z.number().optional().describe("Para params de punto: fracción vertical.")
});

server.registerTool(
  "premiere_keyframe",
  {
    title: "Escribir keyframes",
    description:
      "Escribe uno o varios keyframes en un param de cualquier efecto del clip seleccionado. " +
      "Pasá `lista` para animar: todos los keyframes entran en UNA transacción, así que un " +
      "solo Cmd+Z deshace la animación entera. Sin `lista`, escribe uno en el playhead.\n\n" +
      "Devuelve cuántos keyframes había antes, cuántos después, y EN QUÉ SEGUNDOS quedaron: " +
      "esa diferencia es la única prueba de que pasó algo, porque esta API puede devolver " +
      "éxito sin escribir nada, y puede escribir en el tiempo equivocado.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      param: z.string().describe("Nombre exacto del param, de premiere_efectos. Ej: \"Scale\", \"Position\"."),
      efecto: z.string().optional().describe("Nombre del efecto. Por defecto \"Motion\"."),
      lista: z.array(PUNTO).optional().describe("Para animar: un elemento por keyframe."),
      valor: z
        .union([z.number(), z.boolean()])
        .optional()
        .describe("Para un solo keyframe en el playhead. Booleano para params que son casillas (Volume > Mute)."),
      x: z.number().optional().describe("Para un solo keyframe de punto en el playhead."),
      y: z.number().optional().describe("Idem, la vertical.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("keyframe", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_fijar",
  {
    title: "Poner un valor fijo, sin keyframes",
    description:
      "Escribe un valor FIJO en un param de cualquier efecto. Es lo que se quiere casi siempre: " +
      "una escala, una posición, un color. `premiere_keyframe` es el otro: agrega un keyframe " +
      "EN EL PLAYHEAD, o sea que ANIMA — dos llamadas suyas con el cabezal en lugares distintos " +
      "dejan una animación que nadie pidió.\n\n" +
      "Sirve para colorear con Lumetri: se agrega el efecto con premiere_agregar_efecto " +
      "(matchName \"AE.ADBE Lumetri\") y se van fijando Temperature, Exposure, Contrast, " +
      "Saturation, Highlights, Shadows y demás. Son 130 params y los nombres salen de " +
      "premiere_efectos. NO se pueden cargar presets .prfpset: la API no lo expone.\n\n" +
      "SOBRE UN PARAM ANIMADO NO SIRVE, y esto se midio el 2026-08-25: `fijar` escribe el valor " +
      "BASE y los keyframes lo tapan, asi que el clip sigue viendose igual y el verbo contesta " +
      "NO QUEDO COMO SE PIDIO. Los keyframes NO se borran —eso estuvo escrito al reves durante " +
      "meses— y la escritura queda invisible hasta que no queda ninguno. Para animar hay que " +
      "sacarlos antes con premiere_borrar_keyframe.\n\n" +
      "Devuelve el valor ANTES y DESPUÉS, releídos del clip. Esa diferencia es la prueba: " +
      "esta API puede aceptar una escritura y no aplicarla.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      param: z.string().describe("Nombre exacto del param, de premiere_efectos. Ej: \"Temperature\", \"Scale\"."),
      indiceParam: z.number().optional()
        .describe("Indice del param, de premiere_radiografia. GANA sobre `param` y hace el objetivo " +
          "inequivoco: en Lumetri los nombres SE REPITEN (\"Saturation\" tres veces) porque cada grupo " +
          "anidado tiene el suyo, y apuntar por nombre agarra el primero. Si se pasan los dos y no " +
          "coinciden, RECHAZA: significa que la cadena de efectos cambio y el indice guardado ya no sirve."),
      efecto: z.string().optional().describe("Nombre del efecto. Por defecto \"Motion\"."),
      valor: z
        .union([z.number(), z.boolean()])
        .optional()
        .describe("El valor. Booleano para params que son casillas."),
      x: z.number().optional().describe("Para params de punto (Position), la horizontal en 0-1."),
      y: z.number().optional().describe("Idem, la vertical."),
      nombre: z.string().optional().describe("Parte del nombre del clip. Sin nada, el seleccionado."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Etiqueta de pista: \"V2\", \"A1\"."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("fijar", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_cortes_de_escena",
  {
    title: "Detectar cortes de escena en un clip",
    description:
      "Analiza el material de UN clip y encuentra dónde cambia el plano. Para material largo de " +
      "una pieza —una cámara que grabó toda la jornada, un archivo con varias tomas pegadas— " +
      "donde marcar los cortes a mano lleva media hora.\n\n" +
      "Tres modos. **`marcar` (por defecto) NO toca el timeline**: pone marcadores y es el único " +
      "reversible con sólo borrarlos. `cortar` parte el clip de verdad. `subclips` crea subclips " +
      "en el panel de proyecto.\n\n" +
      "**El objetivo va explícito.** La API opera sobre la selección, así que el verbo pide el " +
      "clip por nombre o pista+índice y lo selecciona él; no corta lo que haya seleccionado.\n\n" +
      "**La prueba de que funcionó son los contadores**, no que la llamada no tire: informa " +
      "cuántos clips o marcadores había antes y después. Si no cambió nada, lo dice.\n\n" +
      "TARDA, porque analiza el medio.",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Nombre del clip a analizar."),
      pista: z.string().optional().describe("Pista donde está, tipo V1 o A2. Con `indice` si hay varios."),
      indice: z.number().optional().describe("Índice del clip dentro de la pista, 0-based."),
      modo: z.enum(["marcar", "cortar", "subclips"]).optional().describe("`marcar` (por defecto) sólo pone marcadores; `cortar` parte el clip; `subclips` crea subclips en el panel."),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("cortesDeEscena", args, 1800000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_etiquetar",
  {
    title: "Etiquetas de color en el panel de proyecto",
    description:
      "Pone o lee la etiqueta de color de medios del panel de proyecto. Para lo que sirve de " +
      "verdad: marcar SUPLENTES. Cuando el bridge propone tomas alternativas, una lista en texto " +
      "obliga a ir a buscar cada clip; con un color el juicio se hace mirando el panel.\n\n" +
      "**Sin `color` sólo LEE** y agrupa por color, que es el modo seguro por defecto.\n\n" +
      "Colores en castellano: violeta, iris, lavanda, ceruleo, bosque, rosa, mango, purpura, " +
      "azul, verdeagua, magenta, tostado, verde, marron, amarillo. OJO: el indice 2 NO existe en " +
      "el enum de Premiere aunque la interfaz muestre 16 slots.\n\n" +
      "Los cambios van en UNA transaccion --una rafaga tira Premiere-- y se **relee cada medio** " +
      "al final: que la transaccion devuelva true no prueba que el valor entro. Cuenta por " +
      "multiplicidad, asi que varias copias con el mismo nombre no se cuentan como una.\n\n" +
      "Avisa cuales matchearon por coincidencia PARCIAL, para que etiquetar de mas no pase " +
      "desapercibido.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medios: z.array(z.string()).optional().describe("Nombres de los medios. Exacto primero; si no hay, parcial (y lo avisa)."),
      medio: z.string().optional().describe("Un solo medio, alternativa a `medios`."),
      color: z.union([z.string(), z.number()]).optional().describe("Color en castellano, nombre de la API, o indice. Sin esto SOLO LEE.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("etiquetar", args, 600000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_interpretar",
  {
    title: "Interpretar material: los fps con que Premiere lee un medio",
    description:
      "Lee o cambia la interpretacion de un medio del panel: fps, pixel aspect ratio, campos y " +
      "alpha. Es el equivalente de Modify > Interpret Footage.\n\n" +
      "**NO es la velocidad del clip ni los fps de la secuencia.** Cambia con que cadencia se lee " +
      "el ARCHIVO: un medio de 24fps interpretado a 25 dura menos y va un 4% mas rapido.\n\n" +
      "**Y cambia el MEDIO, no una instancia**: afecta a todas las apariciones en todas las " +
      "secuencias. Sirve para material generado (Kling sale a 24fps) que hay que conformar a una " +
      "secuencia de 25 sin corregirlo clip por clip.\n\n" +
      "**Sin `fps` solo LEE**, e informa la FORMA que devuelve cada getter --typeof y claves-- " +
      "porque cuando un getter y un setter son de la misma propiedad, la forma del getter es la " +
      "primera que hay que probar en el setter.\n\n" +
      "Al escribir prueba las dos rutas de la API y **relee para confirmar**: que la transaccion " +
      "devuelva true no prueba que el valor entro.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().describe("Nombre del medio en el panel de proyecto. Coincidencia parcial."),
      fps: z.number().optional().describe("Fotogramas por segundo a imponer. Sin esto solo lee.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("interpretar", args, 600000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_proxy",
  {
    title: "Proxies: adjuntar una version liviana de un medio",
    description:
      "Lee o adjunta el proxy de un medio del panel de proyecto. Sirve con material pesado --4K " +
      "vertical, por ejemplo-- donde el timeline se arrastra: se edita con el proxy y **el export " +
      "sigue saliendo del original**, sin tocar la edicion.\n\n" +
      "**Sin `archivo` solo LEE**: si el medio admite proxy, si ya tiene uno y cual, mas la ruta " +
      "del original.\n\n" +
      "El proxy tiene que EXISTIR en disco: Premiere no lo genera desde aca. Se hace con Media " +
      "Encoder o con ffmpeg y despues se adjunta. El verbo comprueba que el archivo este antes " +
      "de adjuntarlo, porque una ruta que no existe deja un proxy roto que Premiere marca offline " +
      "recien al reproducir, y eso se lee como un problema del medio original.\n\n" +
      "La prueba de que funciono es que **hasProxy pase a true Y que getProxyPath devuelva la " +
      "ruta pedida**, no que la llamada no tire.\n\n" +
      "El proxy es del MEDIO: se usa en toda secuencia que lo tenga.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().describe("Nombre del medio en el panel de proyecto. Coincidencia parcial."),
      archivo: z.string().optional().describe("Ruta absoluta del proxy a adjuntar. Sin esto solo lee.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("proxy", args, 600000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_relink",
  {
    title: "Repuntar un medio a otro archivo (relink)",
    description:
      "Le cambia a un medio del panel el ARCHIVO al que apunta. Sirve para reparar un proyecto cuyos " +
      "medios se movieron o se renombraron: el clip vuelve a estar online sin tocar la edicion.\n\n" +
      "**Es del MEDIO, no de una instancia**: afecta a TODA secuencia que lo use.\n\n" +
      "El archivo tiene que EXISTIR: la llamada rebota antes de ejecutar nada si no esta, porque " +
      "repuntar a una ruta ausente deja el medio offline y Premiere recien lo avisa al reproducir.\n\n" +
      "**NO pasa por una transaccion, asi que NO hay Cmd+Z.** Se desanda repuntando a la ruta " +
      "anterior, que el verbo informa.\n\n" +
      "Medido de punta a punta: un proyecto abierto con el medio ausente daba `isOffline true` y " +
      "exportaba la placa roja; despues del relink volvio a exportar identico al sano, y la " +
      "reparacion SOBREVIVE a cerrar y reabrir.\n\n" +
      "Ojo al detectar el problema: **un clip offline NO exporta negro**, exporta la placa " +
      "\"Media Offline\". Lo que lo dice es `isOffline`, no mirar el cuadro. Y Premiere RELINKEA SOLO " +
      "cuando el archivo se movio dentro del arbol del proyecto.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada."
        ),
      medio: z.string().describe("Nombre del medio en el panel de proyecto. Coincidencia parcial."),
      ruta: z.string().describe("Ruta absoluta del archivo al que hay que repuntarlo. Tiene que existir.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("relink", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_clonar",
  {
    title: "Duplicar un clip del timeline con su trabajo",
    description:
      "Copia un clip a otra pista y otro momento, **con sus efectos, su Motion y su recorte**, y el " +
      "clon queda INDEPENDIENTE: retocarlo no toca el original.\n\n" +
      "Es lo que `premiere_agregar_efecto` y el copiado de componentes NO pueden dar: ahi la " +
      "instancia del efecto queda COMPARTIDA entre los dos clips, y apagar el efecto en uno lo apaga " +
      "en el otro. Probado por la inversa —escribiendo en el clon y leyendo el original— con Motion " +
      "y con un Lumetri agregado.\n\n" +
      "El destino se pide ABSOLUTO: `aPista` es el numero de pista (1 = V1) y `aSegundos` el momento " +
      "en la secuencia. El tiempo se cuantiza al cuadro y el verbo dice cuanto lo movio.\n\n" +
      "**OJO: clonar CREA pistas de video** si el destino queda por encima de las que hay, y no hay " +
      "API para borrarlas. El verbo avisa cuando paso.\n\n" +
      "Un Cmd+Z lo saca.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada."
        ),
      pista: z.string().optional().describe('Pista del clip a clonar, como "V1". Con `indice`.'),
      indice: z.number().optional().describe("Índice del clip dentro de la pista, desde 0."),
      nombre: z.string().optional().describe("Alternativa a pista+indice: nombre del clip."),
      aPista: z.number().describe("Pista de video destino, ABSOLUTA. 1 = V1."),
      aSegundos: z.number().describe("Dónde va el clon, en segundos de la secuencia.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("clonar", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_subclip",
  {
    title: "Crear un subclip de un medio",
    description:
      "Un pedazo con nombre de un medio, en el panel de proyecto. Sirve para partir una toma larga " +
      "en selects nombrados sin cortar nada en el timeline: el subclip apunta al mismo archivo con " +
      "otro in/out.\n\n" +
      "Los tiempos son de FUENTE, en segundos desde el inicio del archivo.\n\n" +
      "**La prueba no es que la transaccion devuelva true**: es que aparezca un ProjectItem NUEVO " +
      "con el nombre pedido. Se cuentan los items del panel antes y despues. Y rechaza el nombre " +
      "si ya existe, para no dejar dos items homonimos --los nombres no son unicos en Premiere y " +
      "eso ya rompio dos verbos.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      medio: z.string().describe("Nombre del medio a recortar. Coincidencia parcial."),
      nombre: z.string().describe("Como se va a llamar el subclip."),
      desde: z.number().min(0).describe("Segundo de FUENTE donde empieza."),
      hasta: z.number().min(0).describe("Segundo de FUENTE donde termina."),
      duros: z.boolean().optional().describe("Limites duros: true (por defecto) no deja extenderlo mas alla del rango.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("subclip", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_leer_param",
  {
    title: "Un param, para un rango de clips, en una llamada",
    description:
      "Lee UN parametro (de Motion o de cualquier efecto) para varios clips de una pista, en una " +
      "sola llamada. Existe por eficiencia con un limite que sale de mediciones.\n\n" +
      "**No hay lectura sincronica de valores.** Se probaron `getValueAtTime`, `getValue`, `value` y " +
      "`getStartValue` adentro de un `lockedAccess`, sobre Motion y sobre Lumetri: todos devuelven " +
      "Promise o no existen. Asi que N valores son N promesas, siempre.\n\n" +
      "Lo que decide si eso tira Premiere es CUANTAS entran en una llamada:\n" +
      "  · `param`/`fijar` 1 por llamada -> nunca fallo\n" +
      "  · `leerEscalas` ~176 por llamada -> medido, 6 vueltas sin caerse\n" +
      "  · `radiografia` con params, ~560 -> se cayo 2 de 2 (PromiseFulfillment)\n\n" +
      "El umbral exacto NO esta medido. Este verbo se queda del lado seguro: `limite` 25 por " +
      "defecto, con techo duro de 60. Para 88 clips son 4 llamadas en vez de 88.\n\n" +
      "**`indiceParam` gana sobre `param`**, porque en Lumetri los nombres se repiten. Si se pasan " +
      "los dos y en algun clip no coinciden, ESE clip devuelve error en vez de un valor de otro param.",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.union([z.string(), z.number()]).describe("OBLIGATORIA: \"V1\", \"A1\"."),
      param: z.string().optional().describe("Nombre del param. Ej: \"Rotation\", \"Exposure\"."),
      indiceParam: z.number().optional().describe("Indice del param. GANA sobre `param`; mandar los dos hace que se verifiquen entre si."),
      efecto: z.string().optional().describe("Nombre del efecto. Por defecto \"Motion\"."),
      limite: z.number().optional().describe("Clips por llamada. Por defecto 25, techo 60."),
      desdeIndice: z.number().optional().describe("Desde que indice retomar, con el `siguiente` de la tanda anterior."),
      secuencia: z.string().optional().describe("Guarda: rechaza si la secuencia activa no es esta.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("leerParam", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return texto("No se pudo: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_radiografia",
  {
    title: "Radiografia de una pista: que se perderia si la reconstruyo",
    description:
      "Lee una pista de punta a punta y devuelve, clip por clip, TODO lo que hace falta para " +
      "reproducirlo: tiempos, entrada, salida de fuente, velocidad, si esta deshabilitado, si es " +
      "capa de ajuste, su Motion y los efectos que se le agregaron CON SUS VALORES.\n\n" +
      "**Existe porque el armado es destructivo.** Rehacer una pista desde un JSON pisa todo lo que " +
      "el usuario hizo a mano --una exposicion corregida, una rotacion, un clip apagado, un plano " +
      "corrido un frame--. Antes eso se compensaba REAPLICANDO DE MEMORIA lo que yo recordaba, que es " +
      "el peor modo de fallar: si me olvido uno no hay error ni aviso, el trabajo desaparece.\n\n" +
      "Por eso el veredicto de cada clip es **`intacto`**: false significa que carga trabajo manual y " +
      "que reconstruir esa pista sin restaurarlo lo destruye. El `resumen` los lista con QUE tienen.\n\n" +
      "**Barato por triage**: un clip de video intacto trae exactamente 2 componentes (Opacity y " +
      "Motion), medido. Los params completos se leen solo en los clips que tienen algo agregado, y " +
      "de Motion solo cinco params por nombre. Aun asi va con `limite`/`siguiente`, porque una " +
      "rafaga de lecturas ya tiro Premiere: el 2026-08-21 una vuelta de este mismo verbo se llevo " +
      "Premiere con un fatal en `NAPIContextAdapter::CallCallback` durante `PromiseFulfillment`. La " +
      "Paso TRES veces, con el mismo stack, y las cuatro mitigaciones que se probaron no lo evitaron. " +
      "Por eso este verbo YA NO LEE PARAMS: es solo triage. Para los valores usa `premiere_leer_param` " +
      "(un param por tandas) o `premiere_param` (uno solo).\n\n" +
      "Solo LEE: no escribe nada. Corralo ANTES de cualquier reconstruccion.",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.union([z.string(), z.number()]).optional()
        .describe("OBLIGATORIA: \"V1\", \"A1\". Sin objetivo recorreria la secuencia entera."),
      limite: z.number().optional().describe("Cuantos clips leer en esta tanda. Por defecto 12, NO todos: un barrido de la pista entera es una sola llamada de la que no se vuelve si Premiere se cae."),
      // `conParams` y `maxParams` se eliminaron: leer params en este verbo tiro Premiere tres veces.
      desdeIndice: z.number().optional().describe("Desde que indice retomar, con el `siguiente` de la tanda anterior."),
      secuencia: z.string().optional().describe("Guarda: rechaza si la secuencia activa no es esta.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("radiografia", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return texto("No se pudo: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_desactivar",
  {
    title: "Desactivar o reactivar clips (el ojito del clip)",
    description:
      "Apaga o prende clips con `createSetDisabledAction`. Es el ojito DEL CLIP, no el de la pista.\n\n" +
      "Existe por los SUPLENTES: alternativas puestas en las pistas de arriba TAPAN al corte --en " +
      "Premiere gana la pista de arriba-- asi que la secuencia no se puede ver. Desactivadas quedan a " +
      "la vista en el timeline como opciones y no interfieren con la reproduccion.\n\n" +
      "**ARRASTRA EL AUDIO VINCULADO**, en la misma transaccion. Hasta el 2026-09-10 NO lo hacia: " +
      "apagar V2 dejaba SONANDO A2, y esta descripcion afirmaba lo contrario. Ya mordio una vez --el " +
      "paliativo fue mutear A2/A3/A4 a mano--. El emparejado indexa el otro tipo en UNA pasada, no " +
      "llamando `buscarVinculados` por clip: eso serian N recorridos, el patron medido como causa de " +
      "crash. Con `vinculados:false` se toca solo lo nombrado.\n\n" +
      "**Sin `indice` ni `nombre` opera sobre LA PISTA ENTERA, y todo en UNA transaccion.** Es a " +
      "proposito: el caso real son decenas de suplentes, y una rafaga de transacciones tira Premiere " +
      "con SIGSEGV. Un solo Cmd+Z deshace toda la tanda.\n\n" +
      "**Exige objetivo**: un pedido sin `pista` ni `nombre` se rechaza en vez de desactivar la " +
      "secuencia entera.\n\n" +
      "**Se relee cada clip despues**, volviendo a pedirlos a la pista: que executeTransaction " +
      "devuelva true no prueba que el estado entro, y el objeto viejo puede tenerlo cacheado.",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.union([z.string(), z.number()]).optional()
        .describe("V1, V2, A1... Sin indice ni nombre, la pista ENTERA."),
      indice: z.number().optional().describe("Indice del clip en esa pista, como lo devuelve premiere_clips."),
      nombre: z.string().optional().describe("Nombre (o parte) del clip, alternativa al indice."),
      activar: z.boolean().optional().describe("true los REACTIVA. Por default desactiva."),
      vinculados: z.boolean().optional().describe(
        "Por default TRUE: apagar un video apaga tambien su audio vinculado, en la MISMA " +
        "transaccion. false toca solo lo que se nombra."),
      secuencia: z.string().optional().describe("Guarda: rechaza si la secuencia activa no es esta.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("desactivar", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return texto("No se pudo: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_renombrar_pista",
  {
    title: "Renombrar una pista de la secuencia",
    description:
      "Le pone nombre a una pista de video o audio, como V2 o A1.\n\n" +
      "**Un string vacio NO la vuelve al default**: le pone el nombre literal vacio. Medido. El " +
      "nombre dinamico que Premiere deriva del indice --\"Video 2\"-- no se puede restaurar por " +
      "API, solo escribir un literal que se vea igual. El verbo avisa si se le pasa vacio.\n\n" +
      "Es un verbo aparte de premiere_renombrar a proposito: ahi `pista` sirve para UBICAR un clip, " +
      "y darle un segundo significado haria ambiguo un pedido con pista y nuevo entre renombrar el " +
      "clip de esa pista o renombrar la pista.\n\n" +
      "**Se relee la pista despues**, volviendo a pedirla a la secuencia: el objeto viejo puede " +
      "tener el nombre cacheado, y que la transaccion devuelva true no prueba que el nombre entro.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.string().describe("Etiqueta de la pista: V1, V2, A1..."),
      nuevo: z.string().describe("El nombre que va a tener. Vacio le pone nombre VACIO, no el default.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("renombrarPista", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_exportar",
  {
    title: "Exportar la secuencia activa",
    description:
      "Renderiza la secuencia activa con un preset `.epr`. Era el único hueco real del bridge: " +
      "se podía armar un corte y no había forma de sacarlo.\n\n" +
      "Tres modos. `ame` (por defecto) lo encola en Media Encoder y vuelve al instante; `lote` lo " +
      "encola en el render interno de Premiere; **`ya` bloquea hasta terminar** y es el único que " +
      "permite confirmar el resultado.\n\n" +
      "**La verificación es que el ARCHIVO APAREZCA en disco**, no que la llamada no tire. En los " +
      "modos de cola eso no se puede comprobar —lo escribe otro proceso después— y el verbo lo " +
      "dice en vez de fingir que confirmó. Y si el archivo YA EXISTÍA, avisa que no puede afirmar " +
      "que se reescribió.\n\n" +
      "Premiere trae ~1000 presets en `Contents/MediaIO/systempresets`; para H.264 sirve " +
      "\"00 - Match Source - High bitrate.epr\".",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      preset: z.string().describe("Ruta absoluta a un .epr."),
      salida: z.string().describe("Ruta absoluta del archivo a escribir."),
      modo: z.enum(["ame", "lote", "ya"]).optional().describe("`ame` encola en Media Encoder (por defecto), `lote` en el render de Premiere, `ya` bloquea hasta terminar y es el único verificable."),
      desde: z.number().optional().describe("Segundo donde empieza el rango a exportar. Pone el IN de la secuencia y lo repone al terminar."),
      hasta: z.number().optional().describe("Segundo donde termina. Sin `desde` ni `hasta` se exporta la secuencia entera."),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("exportar", args, 1800000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_quitar_efecto",
  {
    title: "Quitar un efecto de un clip",
    description:
      "Saca un efecto del clip. Es el simetrico de premiere_agregar_efecto, que hasta ahora no " +
      "tenia vuelta: un efecto puesto por error solo se quitaba a mano.\n\n" +
      "Motion y Opacity son INTRINSECOS de todo clip de video y no se pueden quitar: pedirlos " +
      "rebota en vez de intentar algo que la API no hace.\n\n" +
      "Pide el clip por pista+indice o por nombre, como los otros verbos destructivos: un efecto " +
      "que desaparece del clip equivocado no deja hueco ni tira error, solo cambia la imagen.\n\n" +
      "Y RELEE la lista de efectos al terminar: que la transaccion devuelva true no prueba que el " +
      "componente se haya ido.",
    inputSchema: {
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      secuencia: z.string().optional().describe("GUARDA: si la secuencia activa no es esta, rebota."),
      efecto: z.string().describe("Nombre visible del efecto, como lo lista premiere_efectos."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Pista del clip, por ejemplo 2 o \"V2\"."),
      indice: z.number().int().min(0).optional().describe("Indice del clip en esa pista, desde 0."),
      nombre: z.string().optional().describe("O el nombre del clip, si es unico en la pista.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("quitarEfecto", args, 300000);
      return texto(r.resumen, { antes: r.antes, despues: r.despues, seFue: r.seFue, quedan: r.quedan });
    } catch (e) {
      return texto("ERROR: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_crear_proyecto",
  {
    title: "Crear un proyecto nuevo",
    description:
      "Crea un .prproj en la RUTA ABSOLUTA que se le pase y lo deja como el proyecto con foco.\n\n" +
      "El veredicto sale del ESTADO —cual quedo activo— y no de que la llamada no tire: que " +
      "`createProject` devuelva un objeto no prueba que haya creado nada. Y ademas este lado " +
      "MIRA EL DISCO, porque el panel no puede.\n\n" +
      "OJO: crear mueve el foco, asi que las llamadas siguientes con `proyecto` se comparan " +
      "contra el proyecto NUEVO.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Aca sirve para exigir "
          + "DESDE cual se sale. Va en TODAS las herramientas a proposito: una guarda que hay que "
          + "acordarse de tener no esta cuando hace falta."
        ),
      ruta: z.string().describe("Ruta ABSOLUTA del .prproj a crear, con su nombre y extension.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("crearProyecto", args, 600000);
      let enDisco = "no se pudo mirar";
      try { enDisco = require("fs").existsSync(r.ruta) ? "el archivo EXISTE en disco" : "el archivo NO esta en disco"; }
      catch (e) { enDisco = "no se pudo mirar: " + e.message; }
      return texto(r.resumen + " · " + enDisco, { antes: r.antes, despues: r.despues, via: r.via, creo: r.creo });
    } catch (e) {
      return texto("ERROR: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_abrir_proyecto",
  {
    title: "Abrir un proyecto, o traerlo al frente",
    description:
      "Abre un .prproj por su RUTA ABSOLUTA y lo deja como el proyecto con foco. Sirve tambien " +
      "para volver a uno que YA esta abierto: es un cambio de foco, no una recarga.\n\n" +
      "PARA QUE SIRVE: el bridge opera sobre el proyecto CON FOCO, y hasta ahora, si el correcto " +
      "no estaba adelante, lo unico que se podia hacer era rebotar y pedirselo al usuario.\n\n" +
      "MEDIDO el 2026-08-29, y las tres cosas importan:\n" +
      "- Volver a un proyecto ya abierto NO LO RECARGA: se dejaron 33 medios importados sin " +
      "guardar, se cambio de proyecto y al volver seguian los 33.\n" +
      "- Una ruta que no existe tira 'Failed to open the project' y DEJA EL FOCO donde estaba.\n" +
      "- El veredicto sale de releer cual quedo activo, no de que la llamada no tire.\n\n" +
      "OJO: mover el foco mueve la guarda. Despues de esto, las llamadas con `proyecto` se " +
      "comparan contra el NUEVO proyecto.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Aca sirve para exigir "
          + "DESDE cual se sale. Va en TODAS las herramientas a proposito: una guarda que hay que "
          + "acordarse de tener no esta cuando hace falta."
        ),
      ruta: z
        .string()
        .optional()
        .describe(
          "Ruta ABSOLUTA al .prproj. SIN esto no abre nada: informa cual esta activo y que "
          + "contestan los lectores de la API, que es el modo con el que conviene empezar."
        )
    }
  },
  async (args) => {
    try {
      const r = await enviar("abrirProyecto", args, 600000);
      return texto(r.resumen, { antes: r.antes, despues: r.despues, via: r.via, abrio: r.abrio });
    } catch (e) {
      return texto("ERROR: " + (e && e.message ? e.message : String(e)));
    }
  }
);

server.registerTool(
  "premiere_guardar",
  {
    title: "Guardar el proyecto",
    description:
      "Guarda el proyecto abierto. Usalo ANTES de cualquier tanda que toque muchos clips: " +
      "cortes, escalas, zooms. Un Cmd+Z alcanza para una operación, no para veinte.\n\n" +
      "VERIFICA de verdad: el panel no puede leer el disco, así que este lado mira la fecha " +
      "de modificación del .prproj y confirma que cambió. Si `save()` devolviera éxito sin " +
      "escribir —que en esta API pasa— acá se vería.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async ({ proyecto, secuencia }) => {
    try {
      const antes = Date.now();
      const r = await enviar("guardar", { proyecto, secuencia }, 120000);
      let comprobado = "no se pudo comprobar (sin ruta)";
      if (r.ruta) {
        try {
          const st = await require("fs").promises.stat(r.ruta);
          const hace = Math.round((Date.now() - st.mtimeMs) / 1000);
          comprobado = st.mtimeMs >= antes - 2000
            ? `confirmado: el archivo se escribió hace ${hace}s`
            : `OJO: el archivo NO cambió (última escritura hace ${hace}s) — puede que no haya nada que guardar, o que no haya guardado`;
        } catch (e) {
          comprobado = "no se pudo leer el archivo: " + (e && e.message ? e.message : e);
        }
      }
      return texto(r.resumen + " · " + comprobado, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_renombrar",
  {
    title: "Renombrar un clip del timeline",
    description:
      "Le cambia el nombre a UNA instancia de la secuencia, sin tocar el medio del panel de " +
      "proyecto — renombrar el medio se lo cambiaría a todas sus instancias, en todas las " +
      "secuencias.\n\n" +
      "Para qué sirve: marcar en el timeline dónde va a ir algo que todavía no existe. Se " +
      "inserta un Transparent Video y se lo renombra \"Acá va el Ej 1\", y queda a la vista " +
      "en la pista, con la duración del momento que marca. Un marcador de secuencia no ocupa " +
      "lugar ni se ve en la pista.\n\n" +
      "OJO con la duración: para dejarlo de N segundos hay que usar premiere_editar, y su " +
      "`salida` es un punto de FUENTE, no una duración. Los medios sintéticos entran con la " +
      "entrada en ~3600, así que hay que leer la `entrada` real del clip (premiere_clips) y " +
      "sumarle N. Pedir `salida: N` a secas cae antes del in-point y NO HACE NADA.\n\n" +
      "Devuelve el nombre ANTES y DESPUÉS, releídos del clip, y avisa si no quedó como se pidió.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nuevo: z.string().describe("El nombre que va a tener el clip."),
      nombre: z.string().optional().describe("Parte del nombre ACTUAL del clip. Sin nada, el seleccionado."),
      pista: z.union([z.number().int().min(1), z.string()]).optional().describe("Etiqueta de pista: \"V2\", \"A1\"."),
      indice: z.number().int().min(0).optional().describe("Índice dentro de la pista, de premiere_clips.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("renombrar", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_revisar",
  {
    title: "Revisar la secuencia entera",
    description:
      "Recorre todas las pistas y devuelve lo que quedó MAL. Solo lee, no toca nada.\n\n" +
      "Usalo DESPUÉS de cualquier tanda —cortes, escalas, borrados— y antes de dar el trabajo " +
      "por terminado. Cada verbo se verifica a sí mismo, pero nadie verifica el resultado " +
      "combinado, y esta API acepta escrituras que no aplica: que un verbo diga \"reparado\" no " +
      "prueba que la secuencia esté sana.\n\n" +
      "Cuatro chequeos, todos inequívocos:\n" +
      "· CLIPS DE DURACIÓN CERO — Premiere los acepta y no se ven en el timeline.\n" +
      "· SOLAPES.\n" +
      "· HUECOS, medidos en FRAMES: los de 1 frame son cortes que cayeron entre frames y suenan " +
      "como un click; los grandes suelen ser material pendiente puesto a propósito, y van aparte.\n" +
      "· JUNTAS REMOVIBLES — dos clips pegados, mismo medio y continuos en el material, o sea un " +
      "corte que no corta nada. Se limpian con el verbo `unirAudio`.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      pista: z.string().optional().describe("Limitar a una pista: \"V1\", \"A1\". Sin esto, todas."),
      topeFrames: z
        .number()
        .min(0)
        .optional()
        .describe("Hasta cuántos frames cuenta un hueco como sospechoso en vez de intencional. Por defecto 2.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("revisar", args, 180000);
      return texto(r.resumen, r.pistas);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_importar",
  {
    title: "Importar archivos al proyecto",
    description:
      "Importa archivos al panel de proyecto. NO necesita secuencia activa, y ese es el punto: en un " +
      "proyecto recién creado esto es lo primero que se hace, y hasta ahora había que importar a mano " +
      "antes de que el bridge sirviera para algo.\n\n" +
      "Devuelve cuántos medios había antes y después y CUÁLES entraron, no un booleano. Si Premiere " +
      "acepta la llamada y no importa nada —que en esta API pasa— el conteo lo delata.\n\n" +
      "Con `bin` los deja en un bin, creándolo si no está; acepta rutas anidadas con `/`. Y " +
      "COMPRUEBA que quedaron ahí: si la forma que aceptó Premiere fue una sin bin, los mueve " +
      "después y lo dice. Un \"importados 12\" con el bin vacío es un informe que miente.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      archivos: z
        .union([z.string(), z.array(z.string())])
        .describe("Ruta absoluta, o lista de rutas absolutas, de los archivos a importar."),
      bin: z.string().optional().describe("Bin donde dejarlos, creándolo si falta. Anidado con \"/\", por ejemplo \"CN 19-12/1 El baño\".")
    }
  },
  async (args) => {
    try {
      const r = await enviar("importar", args, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_bins",
  {
    title: "Crear bins y ordenar los medios adentro",
    description:
      "Sin argumentos LISTA el árbol de bins con cuántos medios tiene cada uno, y cuántos quedaron " +
      "sueltos en la raíz. Con `bin` lo crea si no está —anidado con \"/\"— y con `medios` mueve " +
      "adentro los que coincidan por nombre parcial, buscándolos en TODO el proyecto y no sólo en la " +
      "raíz.\n\n" +
      "Devuelve cuántos medios tenía el bin antes y después, y cuáles NO se pudieron mover. " +
      "`createMoveItemAction` es una transacción como cualquier otra de esta API: puede pasar sin " +
      "aplicar, así que el verbo relee el bin en vez de confiar en que la llamada no tiró.\n\n" +
      "No necesita secuencia activa.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      bin: z.string().optional().describe("Ruta del bin, anidada con \"/\". Sin esto, sólo lista."),
      borrar: z.boolean().optional().describe("Borra el bin. Se niega si tiene cosas adentro: borrarlo se las lleva y deja sin medio a las secuencias que las usen."),
      aunqueTengaCosas: z.boolean().optional().describe("Insiste en borrar un bin con contenido. Destructivo."),
      medios: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Nombre o nombres parciales de los medios a mover adentro.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("bins", args || {}, 300000);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

/* ---------- marcadores de secuencia ---------- */

server.registerTool(
  "premiere_marcadores",
  {
    title: "Los marcadores de la secuencia",
    description:
      "Lista los marcadores de la secuencia activa: segundo, nombre, comentario y color.\n\n" +
      "Los marcadores sirven para una capa de anotación que NO ocupa una pista: citas, datos " +
      "para destacar, cosas a chequear. Si en cambio querés que se vea en el timeline y cubra " +
      "un rango, va un Transparent Video renombrado (premiere_insertar + premiere_renombrar).",
    inputSchema: {
      clip: z.string().optional().describe(
        "Para marcar un CLIP en vez de la secuencia: nombre (o parte) del clip. OJO: el marcador "
        + "queda en el MEDIO, asi que `segundos` es TIEMPO DE FUENTE y el marcador se ve en TODA "
        + "instancia de ese material. Es lo que se quiere para una grilla de beats sobre una pista "
        + "de musica: sobrevive a mover el audio, cosa que un marcador de secuencia no hace."
      ),
      pista: z.string().optional().describe("Alternativa a `clip`: la pista, por ejemplo \"V1\" o \"A2\"."),
      indice: z.number().int().min(0).optional().describe("Con `pista`: el indice del clip en esa pista."),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async ({ proyecto, secuencia }) => {
    try {
      const r = await enviar("marcadores", { proyecto, secuencia });
      return texto(r.resumen, r.marcadores);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_marcar",
  {
    title: "Poner un marcador",
    description:
      "Deja un marcador en un segundo de la secuencia activa, con nombre, comentario y color.\n\n" +
      "El color es lo que permite tener varias capas de anotación distinguibles a simple vista " +
      "en la misma secuencia. Se acepta por nombre —verde, rojo, magenta, naranja, amarillo, " +
      "azul, cyan— o por índice. OJO: la constante de la API expone 0-4, 6 y 7; el 5 EXISTE en " +
      "Premiere pero no está en la lista, así que solo se llega por número.\n\n" +
      "Poner el color es una transacción APARTE de crear el marcador, así que con color son DOS " +
      "Cmd+Z. El verbo lo dice en el resumen y relee el color del marcador para confirmarlo.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      segundos: z.number().min(0).describe(
        "Dónde va. En segundos de la SECUENCIA, salvo que se apunte a un clip: ahí es tiempo de FUENTE."
      ),
      clip: z.string().optional().describe(
        "Para marcar un CLIP en vez de la secuencia: nombre (o parte) del clip. OJO: el marcador "
        + "queda en el MEDIO, asi que `segundos` es TIEMPO DE FUENTE y el marcador se ve en TODA "
        + "instancia de ese material. Es lo que se quiere para una grilla de beats sobre una pista "
        + "de musica: sobrevive a mover el audio, cosa que un marcador de secuencia no hace."
      ),
      pista: z.string().optional().describe("Alternativa a `clip`: la pista, por ejemplo \"V1\" o \"A2\"."),
      indice: z.number().int().min(0).optional().describe("Con `pista`: el indice del clip en esa pista."),
      nombre: z.string().optional().describe("El texto que se ve en el marcador. Por defecto \"Nota\"."),
      comentario: z.string().optional().describe("El texto largo, que se ve al abrirlo."),
      color: z
        .union([z.string(), z.number().int().min(0).max(7)])
        .optional()
        .describe("Nombre del color o índice. Sin esto, el color por defecto de Premiere."),
      duracion: z.number().min(0).optional().describe("Largo del marcador en segundos. Por defecto 0 (un punto).")
    }
  },
  async (args) => {
    try {
      const r = await enviar("marcar", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_desmarcar",
  {
    title: "Sacar marcadores",
    description:
      "Saca los marcadores cuyo nombre CONTENGA el texto que se pase, o todos con `todos: true`.\n\n" +
      "El match es por subcadena, así que un texto corto puede llevarse más de lo que se quiere. " +
      "Mirá primero con premiere_marcadores: una secuencia puede tener marcadores puestos por el " +
      "usuario o por otra tanda, y borrarlos no se avisa solo.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      nombre: z.string().optional().describe("Saca los que contengan este texto."),
      todos: z.boolean().optional().describe("true saca todos los marcadores del sujeto."),
      clip: z.string().optional().describe("Nombre de un clip: saca los marcadores DE ESE CLIP en vez de los de la secuencia. Los que crea premiere_cortes_de_escena en modo marcar viven ahi."),
      pista: z.string().optional().describe("Pista del clip, tipo V2. Con indice si hay varios."),
      indice: z.number().optional().describe("Indice del clip dentro de la pista, 0-based.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("desmarcar", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);



server.registerTool(
  "premiere_editar_marcador",
  {
    title: "Cambiar un marcador ya puesto",
    description:
      "Mueve un marcador, le cambia el color o le cambia el RANGO, sin borrarlo y rehacerlo.\n\n" +
      "Hasta ahora corregir un marcador mal puesto era sacarlo y volver a crearlo con su nombre, " +
      "su comentario y su color. Se pueden pedir los tres cambios juntos; cada uno es una " +
      "transaccion, asi que el resumen dice cuantos Cmd+Z hacen falta.\n\n" +
      "EL MOVIMIENTO SE CUANTIZA AL FRAME. La API no lo hace —pedir 9,017s a 25fps deja 9,02, " +
      "medio cuadro— y un marcador subframe deja de decir donde esta el corte.\n\n" +
      "Se apunta por `marcador` (nombre) o por `indice`. Si el nombre coincide con varios, REBOTA " +
      "en vez de elegir: un marcador movido no deja rastro de donde estaba.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        ),
      marcador: z.string().optional().describe("Nombre (o parte) del marcador a cambiar."),
      indice: z.number().int().min(0).optional().describe("Alternativa a `marcador`: su posicion en la lista, 0-based."),
      segundos: z.number().min(0).optional().describe("Nuevo tiempo. Se cuantiza al frame y el resumen dice cuanto movio."),
      duracion: z.number().min(0).optional().describe("Nuevo RANGO en segundos. 0 lo vuelve un marcador de punto."),
      color: z.number().int().min(0).max(15).optional().describe("Nuevo color por indice."),
      clip: z.string().optional().describe("Para editar un marcador DE UN CLIP en vez de uno de la secuencia."),
      pista: z.string().optional().describe("Pista del clip, tipo V2. Con indice si hay varios.")
    }
  },
  async (args) => {
    try {
      const r = await enviar("editarMarcador", args);
      return texto(r.resumen, r);
    } catch (e) {
      return fallo(e);
    }
  }
);



server.registerTool(
  "premiere_borrar_keyframe",
  {
    title: "Borrar keyframes de un param",
    description:
      "BORRA keyframes por tiempo, sin tocar los demas. Era el verbo que faltaba: `keyframe` " +
      "agrega o sobrescribe, y `fijar` escribe el valor BASE, que sobre un param animado la " +
      "animacion tapa. No habia forma de sacar un keyframe.\n\n" +
      "EXIGE EL CLIP EXPLICITO, por nombre o por pista+indice. Un keyframe borrado no deja " +
      "hueco, no tira error y no se ve en el timeline: solo cambia la animacion.\n\n" +
      "Devuelve cuantos habia, cuantos quedaron y EN QUE SEGUNDOS, que es la unica prueba de " +
      "que paso lo que se pidio y no otra cosa.",
    inputSchema: {
      nombre: z.string().optional().describe("Nombre del clip. Alternativa a pista+indice."),
      pista: z.string().optional().describe('Pista del clip, como la devuelve `clips`: "V2", "A1".'),
      indice: z.number().int().min(0).optional().describe("Indice del clip en esa pista, como lo devuelve `clips`."),
      efecto: z.string().optional().describe('Efecto que contiene el param. Por defecto "Motion".'),
      param: z.string().describe('Nombre visible del param, como lo devuelve `efectos`. Ej: "Position", "Scale".'),
      indiceParam: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Indice del param. Hace falta cuando el nombre se repite, como en Lumetri."),
      tolerancia: z
        .number()
        .optional()
        .describe("Margen en segundos para emparejar un tiempo con un keyframe. Por defecto 0,02 (medio cuadro a 25fps)."),
      segundos: z
        .union([z.number(), z.array(z.number())])
        .describe("Segundo o lista de segundos, en el reloj de la SECUENCIA, de los keyframes a borrar."),
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async (args) => {
    try {
      const r = await enviar("borrarKeyframe", args, 120000);
      return texto(r.resumen, { antes: r.antes, despues: r.despues, borrados: r.borrados });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_mover_keyframe",
  {
    title: "Mover un keyframe de tiempo",
    description:
      "Mueve UN keyframe de un tiempo a otro conservando su valor. Se compone de escribir en " +
      "el destino y borrar el origen, asi que el veredicto no es que la llamada no tire: se " +
      "relee y se exige que la cantidad no haya cambiado, que el destino este y que el origen " +
      "no.\n\n" +
      "NO escribe sobre un tiempo que ya tiene keyframe: hay un crash de Premiere registrado " +
      "en esa situacion, con la causa sin identificar. Si el destino esta ocupado, rebota.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      nombre: z.string().optional().describe("Nombre del clip. Alternativa a pista+indice."),
      pista: z.string().optional().describe('Pista del clip, como la devuelve `clips`: "V2", "A1".'),
      indice: z.number().int().min(0).optional().describe("Indice del clip en esa pista, como lo devuelve `clips`."),
      efecto: z.string().optional().describe('Efecto que contiene el param. Por defecto "Motion".'),
      param: z.string().describe('Nombre visible del param, como lo devuelve `efectos`. Ej: "Position", "Scale".'),
      indiceParam: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Indice del param. Hace falta cuando el nombre se repite, como en Lumetri."),
      tolerancia: z
        .number()
        .optional()
        .describe("Margen en segundos para emparejar un tiempo con un keyframe. Por defecto 0,02 (medio cuadro a 25fps)."),
      de: z.number().describe("Segundo actual del keyframe, en el reloj de la secuencia."),
      a: z.number().describe("Segundo al que se lo quiere llevar."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async (args) => {
    try {
      const r = await enviar("moverKeyframe", args, 120000);
      return texto(r.resumen, { ok: r.ok, antes: r.antes, despues: r.despues });
    } catch (e) {
      return fallo(e);
    }
  }
);

server.registerTool(
  "premiere_curva_keyframe",
  {
    title: "Cambiar la curva de uno o varios keyframes",
    description:
      "Cambia la interpolacion temporal: `lineal`, `bezier`, `hold` (escalon) o `tiempo`. Sin " +
      "`segundos` los toca TODOS, que es el pedido normal y es seguro porque cambiar la curva " +
      "no borra ni mueve nada.\n\n" +
      "*** BEZIER NO SUAVIZA POR SI SOLO. *** Pone el TIPO; los tiradores —la influencia, el " +
      "ease— NO existen en la API: Keyframe expone position, value y el modo, y nada mas. Un " +
      "bezier con los tiradores en cero se interpola IGUAL que un lineal, y el icono en Effect " +
      "Controls SI cambia, asi que parece que funciono. Medido el 2026-08-25. Para que el " +
      "movimiento cambie hay que arrastrar los tiradores a mano o usar Ease In/Out. `hold` y " +
      "`lineal` si cambian el movimiento.\n\n" +
      "LA RELECTURA DEL MODO ES BEST-EFFORT y el verbo lo dice: leerlo exige un objeto " +
      "Keyframe, que es la familia de referencias que tiro Premiere con SIGBUS en rafaga. Si " +
      "no se puede releer, avisa que NO esta confirmado en vez de dar por bueno.",
    inputSchema: {
      secuencia: z.string().optional().describe("Guarda: si la secuencia activa no es ésta, no se ejecuta nada."),
      nombre: z.string().optional().describe("Nombre del clip. Alternativa a pista+indice."),
      pista: z.string().optional().describe('Pista del clip, como la devuelve `clips`: "V2", "A1".'),
      indice: z.number().int().min(0).optional().describe("Indice del clip en esa pista, como lo devuelve `clips`."),
      efecto: z.string().optional().describe('Efecto que contiene el param. Por defecto "Motion".'),
      param: z.string().describe('Nombre visible del param, como lo devuelve `efectos`. Ej: "Position", "Scale".'),
      indiceParam: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Indice del param. Hace falta cuando el nombre se repite, como en Lumetri."),
      tolerancia: z
        .number()
        .optional()
        .describe("Margen en segundos para emparejar un tiempo con un keyframe. Por defecto 0,02 (medio cuadro a 25fps)."),
      modo: z
        .string()
        .describe("lineal | bezier (o suave) | hold (o escalon) | tiempo."),
      segundos: z
        .union([z.number(), z.array(z.number())])
        .optional()
        .describe("Que keyframes tocar, en segundos de la secuencia. Sin esto, TODOS los del param."),
      proyecto: z
        .string()
        .optional()
        .describe(
          "GUARDA: nombre (o parte) del proyecto sobre el que se quiere operar. Si el que tiene "
          + "foco en Premiere es otro, la llamada REBOTA sin ejecutar nada. Va en TODAS las "
          + "herramientas a proposito: una guarda que hay que acordarse de tener no esta cuando hace falta."
        )
    }
  },
  async (args) => {
    try {
      const r = await enviar("curvaKeyframe", args, 120000);
      return texto(r.resumen, { tocados: r.tocados, modosAntes: r.modosAntes, modosDespues: r.modosDespues });
    } catch (e) {
      return fallo(e);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr y no stdout: stdout es el canal del protocolo MCP, escribir ahí lo rompe.
  console.error("premiere-bridge escuchando por stdio");
}

/*
 * Solo arranca si se lo EJECUTA. Requerido desde otro archivo —`test.js` lo hace
 * para comprobar que carga— no debe abrir el transporte: si lo abre, el proceso
 * queda escuchando y el test nunca termina. Pasó el 2026-08-16.
 */
if (require.main === module) {
  main().catch((e) => {
    console.error("premiere-bridge no arrancó:", e);
    process.exit(1);
  });
}

module.exports = { server };
