// Self-contained API reference page served at `GET /v1/docs`.
//
// No CDN, no external scripts/styles/fonts, no `node_modules` served from disk:
// the whole viewer is inline and fetches the spec from `openapi.json` (relative
// to `/v1/docs`, which resolves to `/v1/openapi.json`). This is deliberate. The
// server ships as a `tsc` build, a `tsx` dev process, and an esbuild single-file
// bundle for the desktop app that carries no server `node_modules` — so pulling
// Swagger UI from `node_modules` at runtime would 404 in the desktop build, and
// vendoring its ~1.5 MB of assets into the repo would be bloat. A compact
// hand-rolled renderer keeps the docs offline-capable and identical across all
// three run targets. It is stored as a `.ts` string module (not an `.html`
// file) for the same reason the spec is: `.ts` compiles and bundles everywhere,
// while a static file is not copied into `dist/` and is absent from the bundle.
//
// Rendered client-side from the OpenAPI JSON via DOM APIs (no innerHTML
// templating), so nothing in the spec can inject markup.

export const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FreeLLMAPI - API reference</title>
  <style>
    :root {
      --bg: #ffffff; --fg: #1b1f24; --muted: #5b6472; --border: #e4e8ee;
      --card: #f7f9fc; --accent: #2f6feb; --code-bg: #f0f3f8;
      --get: #1f883d; --post: #2f6feb; --put: #9a6700; --delete: #cf222e;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --border: #21262d;
        --card: #161b22; --accent: #4c8dff; --code-bg: #161b22;
        --get: #3fb950; --post: #4c8dff; --put: #d29922; --delete: #f85149;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--fg);
      font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
    header.top {
      position: sticky; top: 0; z-index: 5; background: var(--bg);
      border-bottom: 1px solid var(--border); padding: 18px 24px;
    }
    header.top h1 { margin: 0; font-size: 20px; display: inline-block; }
    .ver { margin-left: 10px; font-size: 12px; color: var(--muted); border: 1px solid var(--border);
      border-radius: 999px; padding: 2px 8px; vertical-align: middle; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 24px; }
    p.desc { color: var(--muted); margin: 8px 0 0; }
    .auth { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: 14px 16px; margin: 22px 0; }
    .auth h2 { margin: 0 0 6px; font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    .group h2 { font-size: 16px; margin: 30px 0 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .op { border: 1px solid var(--border); border-radius: 10px; margin: 12px 0; overflow: hidden; }
    .op > summary { list-style: none; cursor: pointer; padding: 12px 14px; display: flex; gap: 12px;
      align-items: center; user-select: none; }
    .op > summary::-webkit-details-marker { display: none; }
    .op[open] > summary { border-bottom: 1px solid var(--border); }
    .method { font-weight: 700; font-size: 12px; letter-spacing: .05em; text-transform: uppercase;
      color: #fff; border-radius: 6px; padding: 3px 9px; flex: 0 0 auto; }
    .m-get { background: var(--get); } .m-post { background: var(--post); }
    .m-put { background: var(--put); } .m-delete { background: var(--delete); }
    .path { font-size: 14px; font-weight: 600; }
    .sum { color: var(--muted); font-size: 13px; margin-left: auto; text-align: right; }
    .body { padding: 6px 16px 16px; }
    .body h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted);
      margin: 18px 0 8px; }
    .op p.opdesc { color: var(--muted); margin: 10px 0 0; }
    table.params { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.params td { border-top: 1px solid var(--border); padding: 7px 8px; vertical-align: top; }
    .pill { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 5px;
      border: 1px solid var(--border); color: var(--muted); margin-left: 6px; }
    .req { color: var(--delete); font-size: 11px; margin-left: 6px; }
    .schema { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 14px; overflow-x: auto; }
    .schema ul { list-style: none; margin: 0; padding-left: 16px; }
    .schema > ul { padding-left: 0; }
    .field { padding: 2px 0; }
    .fname { font-weight: 600; }
    .ftype { color: var(--accent); font-size: 12px; }
    .fdesc { color: var(--muted); font-size: 12px; }
    .resp { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; font-size: 13px; }
    .code { font-weight: 700; }
    .c2 { color: var(--get); } .c4 { color: var(--put); } .c5 { color: var(--delete); }
    a { color: var(--accent); }
    .loading, .error { color: var(--muted); padding: 40px 0; text-align: center; }
    .error { color: var(--delete); }
  </style>
</head>
<body>
  <header class="top"><div class="wrap" style="padding:0;"><h1 id="doc-title">FreeLLMAPI</h1><span class="ver" id="doc-ver"></span></div></header>
  <main class="wrap"><div id="root"><p class="loading">Loading API reference…</p></div></main>
  <script>
  (function () {
    var root = document.getElementById('root');
    var spec = null;

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function resolveRef(ref) {
      if (typeof ref !== 'string' || ref.indexOf('#/') !== 0) return null;
      var parts = ref.slice(2).split('/');
      var cur = spec;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return null;
        cur = cur[parts[i]];
      }
      return cur || null;
    }

    function typeLabel(schema) {
      if (!schema) return 'any';
      if (schema.$ref) {
        var name = schema.$ref.split('/').pop();
        return name;
      }
      if (schema.oneOf || schema.anyOf) {
        var list = schema.oneOf || schema.anyOf;
        return list.map(typeLabel).join(' | ');
      }
      if (schema.enum) return schema.enum.map(function (v) { return JSON.stringify(v); }).join(' | ');
      if (schema.type === 'array') return typeLabel(schema.items) + '[]';
      return schema.type || 'object';
    }

    // Render a schema as a nested field list. depth guards against cycles.
    function renderSchema(schema, depth) {
      depth = depth || 0;
      var container = el('div');
      if (!schema) { container.appendChild(el('div', 'fdesc', 'any')); return container; }
      if (schema.$ref) {
        var resolved = resolveRef(schema.$ref);
        if (depth > 6 || !resolved) { container.appendChild(el('div', 'ftype', typeLabel(schema))); return container; }
        return renderSchema(resolved, depth + 1);
      }
      if (schema.oneOf || schema.anyOf) {
        var opts = schema.oneOf || schema.anyOf;
        container.appendChild(el('div', 'fdesc', 'One of: ' + opts.map(typeLabel).join(', ')));
        return container;
      }
      if (schema.type === 'array') {
        container.appendChild(el('div', 'ftype', typeLabel(schema.items) + '[]'));
        if (schema.items && (schema.items.properties || schema.items.$ref)) {
          container.appendChild(renderSchema(schema.items, depth + 1));
        }
        return container;
      }
      if (schema.properties) {
        var required = schema.required || [];
        var ul = el('ul');
        Object.keys(schema.properties).forEach(function (key) {
          var prop = schema.properties[key];
          var li = el('li', 'field');
          var line = el('div');
          var nameEl = el('span', 'fname mono', key);
          line.appendChild(nameEl);
          line.appendChild(el('span', 'ftype', ' ' + typeLabel(prop)));
          if (required.indexOf(key) !== -1) line.appendChild(el('span', 'req', 'required'));
          li.appendChild(line);
          if (prop.description) li.appendChild(el('div', 'fdesc', prop.description));
          if (prop.default !== undefined) li.appendChild(el('div', 'fdesc', 'default: ' + JSON.stringify(prop.default)));
          // Expand one level of nested object/array-of-object properties.
          var nested = prop.$ref ? resolveRef(prop.$ref) : (prop.type === 'array' ? prop.items : prop);
          if (depth < 3 && nested && nested.properties && prop !== nested) {
            li.appendChild(renderSchema(prop, depth + 1));
          }
          ul.appendChild(li);
        });
        container.appendChild(ul);
        return container;
      }
      container.appendChild(el('div', 'ftype', typeLabel(schema)));
      if (schema.description) container.appendChild(el('div', 'fdesc', schema.description));
      return container;
    }

    function schemaFromContent(content) {
      if (!content) return null;
      var key = content['application/json'] ? 'application/json' : Object.keys(content)[0];
      return content[key] ? content[key].schema : null;
    }

    function methodClass(m) { return 'm-' + m; }
    function codeClass(code) { return 'c' + String(code).charAt(0); }

    function renderOperation(path, method, op) {
      var details = el('details', 'op');
      var summary = el('summary');
      var badge = el('span', 'method ' + methodClass(method), method);
      summary.appendChild(badge);
      summary.appendChild(el('span', 'path mono', path));
      if (op.summary) summary.appendChild(el('span', 'sum', op.summary));
      details.appendChild(summary);

      var body = el('div', 'body');
      if (op.description) body.appendChild(el('p', 'opdesc', op.description));

      if (op.parameters && op.parameters.length) {
        body.appendChild(el('h3', null, 'Query parameters'));
        var table = el('table', 'params');
        op.parameters.forEach(function (p) {
          var tr = el('tr');
          var td1 = el('td');
          td1.appendChild(el('span', 'fname mono', p.name));
          if (p.required) td1.appendChild(el('span', 'req', 'required'));
          var td2 = el('td');
          td2.appendChild(el('div', 'ftype', typeLabel(p.schema)));
          if (p.description) td2.appendChild(el('div', 'fdesc', p.description));
          tr.appendChild(td1); tr.appendChild(td2);
          table.appendChild(tr);
        });
        body.appendChild(table);
      }

      if (op.requestBody) {
        body.appendChild(el('h3', null, 'Request body' + (op.requestBody.required ? ' (required)' : '')));
        var reqSchema = schemaFromContent(op.requestBody.content);
        var box = el('div', 'schema');
        box.appendChild(renderSchema(reqSchema, 0));
        body.appendChild(box);
      }

      body.appendChild(el('h3', null, 'Responses'));
      Object.keys(op.responses || {}).forEach(function (code) {
        var r = op.responses[code];
        if (r.$ref) r = resolveRef(r.$ref) || r;
        var row = el('div', 'resp');
        row.appendChild(el('span', 'code mono ' + codeClass(code), code));
        row.appendChild(el('span', 'fdesc', r.description || ''));
        body.appendChild(row);
        var respSchema = schemaFromContent(r.content);
        if (respSchema && (respSchema.$ref || respSchema.properties)) {
          var rbox = el('div', 'schema');
          rbox.style.margin = '2px 0 8px';
          rbox.appendChild(renderSchema(respSchema, 0));
          body.appendChild(rbox);
        }
      });

      details.appendChild(body);
      return details;
    }

    function render() {
      document.title = (spec.info && spec.info.title ? spec.info.title : 'API') + ' - API reference';
      var titleEl = document.getElementById('doc-title');
      var verEl = document.getElementById('doc-ver');
      if (spec.info) {
        titleEl.textContent = spec.info.title || 'API';
        if (spec.info.version) verEl.textContent = 'v' + spec.info.version;
      }
      root.innerHTML = '';

      if (spec.info && spec.info.description) root.appendChild(el('p', 'desc', spec.info.description));

      // Auth summary from the declared security schemes.
      var schemes = spec.components && spec.components.securitySchemes;
      if (schemes) {
        var authBox = el('div', 'auth');
        authBox.appendChild(el('h2', null, 'Authentication'));
        Object.keys(schemes).forEach(function (name) {
          var s = schemes[name];
          authBox.appendChild(el('div', 'fdesc', s.description || (s.type + (s.scheme ? ' ' + s.scheme : ''))));
        });
        root.appendChild(authBox);
      }

      // Group operations by their first tag, in the order tags are declared.
      var tagOrder = (spec.tags || []).map(function (t) { return t.name; });
      var groups = {};
      var order = [];
      Object.keys(spec.paths || {}).forEach(function (path) {
        var item = spec.paths[path];
        Object.keys(item).forEach(function (method) {
          var op = item[method];
          if (!op || typeof op !== 'object') return;
          var tag = (op.tags && op.tags[0]) || 'Endpoints';
          if (!groups[tag]) { groups[tag] = []; order.push(tag); }
          groups[tag].push({ path: path, method: method.toUpperCase(), op: op });
        });
      });
      order.sort(function (a, b) {
        var ia = tagOrder.indexOf(a), ib = tagOrder.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });

      order.forEach(function (tag) {
        var g = el('div', 'group');
        g.appendChild(el('h2', null, tag));
        groups[tag].forEach(function (entry) {
          g.appendChild(renderOperation(entry.path, entry.method, entry.op));
        });
        root.appendChild(g);
      });
    }

    // Relative fetch: from /v1/docs this resolves to /v1/openapi.json, so the
    // page keeps working behind any path prefix or reverse proxy.
    fetch('openapi.json', { headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) { spec = data; render(); })
      .catch(function (err) {
        root.innerHTML = '';
        root.appendChild(el('p', 'error', 'Failed to load the API spec: ' + err.message));
      });
  })();
  </script>
</body>
</html>`;
