# NEXO · Tu círculo, tu seguridad

App web (HTML + CSS + JavaScript puro) tipo Life360: círculos, ubicación en vivo, lugares, SOS y navegación con Waze.

## Estructura de carpetas (importante)

```
index.html
css/estilos.css
js/config.js      <- aquí van tus claves de Supabase
js/datos.js
js/supabase.js
js/app.js
supabase/esquema.sql
```

## Dos modos

| Modo | Cuándo | Qué significa |
| --- | --- | --- |
| **Local** | `js/config.js` vacío | Todo vive en el navegador (localStorage). Cuentas demo: `alicia@nexo.app` / `demo123`. **Un círculo creado en un dispositivo NO existe en otro**, por eso un código "no existe" si lo pruebas desde otro celular o navegador. |
| **Nube (real)** | `js/config.js` con tus claves | Usuarios reales, círculos y ubicación compartidos entre dispositivos en tiempo real. |

## Activar la nube (5 minutos)

1. Crea un proyecto gratis en https://supabase.com
2. **SQL Editor** → pega **todo** `supabase/esquema.sql` → *Run*. (Se puede volver a ejecutar sin perder datos.)
3. **Authentication → Providers → Email** → desactiva **Confirm email** (si no, cada cuenta nueva debe confirmar su correo).
4. **Project Settings → API** → copia *Project URL* y *anon public key* y pégalos en `js/config.js`.
5. Publica la carpeta con **HTTPS** (GitHub Pages, Netlify, Vercel). El GPS del navegador no funciona sin HTTPS (solo en `localhost`).

## Agregar personas con correo y contraseña

Como líder o co-líder: **Grupo → Ver círculo → + Agregar integrante** (o **Perfil → Agregar personas**).
Escribes nombre, correo y contraseña (o tocas *Generar*). La app crea la cuenta, la suma al círculo y te muestra los datos para copiarlos o mandarlos por WhatsApp. La persona entra desde la pantalla de login con ese correo y contraseña.

## Unirse a un círculo

- Con el **código** (ej. `NEXO8UBZ`; no importan mayúsculas ni espacios).
- Con el **enlace** o el **QR** que genera el líder (en la nube el enlace lleva solo el código).

## Notas

- Cada cuenta nueva (que no venga de invitación) arranca con su propio círculo "Mi círculo".
- La ubicación está **oculta por defecto**: cada persona debe activarla (hay un botón en el mapa).
- El navegador pausa el GPS con la pantalla bloqueada; para eso haría falta una app nativa.
