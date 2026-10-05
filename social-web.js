/** Opt-in schedule-sharing map. No external libraries or third-party requests. */
(function () {
  'use strict';

  // A deterministic spring layout: disconnected groups have separate centers,
  // while linked people attract each other and nearby nodes repel. Dense sharing
  // circles settle together without claiming that a cluster is a friendship.
  function layout(profiles, edges) {
    var nodes = profiles.map(function (profile) {
      return { profileId: profile.profileId, displayName: profile.displayName, x: 0, y: 0 };
    });
    var byId = new Map(nodes.map(function (node) { return [node.profileId, node]; }));
    var neighbors = new Map(nodes.map(function (node) { return [node.profileId, []]; }));
    var links = edges.filter(function (edge) {
      return edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target);
    });
    links.forEach(function (edge) {
      neighbors.get(edge.source).push(edge.target);
      neighbors.get(edge.target).push(edge.source);
    });
    var visited = new Set();
    var groups = [];
    nodes.forEach(function (node) {
      if (visited.has(node.profileId)) return;
      var queue = [node.profileId];
      var group = [];
      visited.add(node.profileId);
      for (var i = 0; i < queue.length; i++) {
        var id = queue[i];
        group.push(byId.get(id));
        neighbors.get(id).forEach(function (other) {
          if (!visited.has(other)) { visited.add(other); queue.push(other); }
        });
      }
      groups.push(group);
    });
    groups.sort(function (a, b) { return b.length - a.length; });
    var sizes = groups.map(function (group) { return Math.max(210, Math.sqrt(group.length) * 170); });
    var columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
    var rowY = 0;
    for (var start = 0; start < groups.length; start += columns) {
      var row = groups.slice(start, start + columns);
      var height = Math.max.apply(null, sizes.slice(start, start + columns)) * 2;
      var columnX = 0;
      row.forEach(function (group, column) {
        var radius = sizes[start + column];
        var cx = columnX + radius;
        var cy = rowY + height / 2;
        group.forEach(function (node, i) {
          var angle = i * 2.399963;
          // Spread further inside the group so labels and the lines between
          // people do not sit on top of each other.
          var r = Math.sqrt(i) * 96;
          node.x = cx + Math.cos(angle) * r;
          node.y = cy + Math.sin(angle) * r;
          node.cx = cx; node.cy = cy;
        });
        columnX += radius * 2 + 170;
      });
      rowY += height + 170;
    }
    // Spatial buckets avoid an all-pairs simulation on a whole school's graph.
    for (var step = 0; step < 180; step++) {
      var buckets = new Map();
      nodes.forEach(function (node) {
        node.fx = (node.cx - node.x) * 0.008;
        node.fy = (node.cy - node.y) * 0.008;
        var key = Math.floor(node.x / 275) + ',' + Math.floor(node.y / 275);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(node);
      });
      nodes.forEach(function (node) {
        var bx = Math.floor(node.x / 275), by = Math.floor(node.y / 275);
        for (var gx = bx - 1; gx <= bx + 1; gx++) {
          for (var gy = by - 1; gy <= by + 1; gy++) {
            (buckets.get(gx + ',' + gy) || []).forEach(function (other) {
              if (node === other) return;
              var dx = node.x - other.x, dy = node.y - other.y;
              var distance = Math.max(1, Math.hypot(dx, dy));
              if (distance > 275) return;
              var force = Math.min(20, 3900 / (distance * distance));
              node.fx += dx / distance * force;
              node.fy += dy / distance * force;
            });
          }
        }
      });
      links.forEach(function (edge) {
        var a = byId.get(edge.source), b = byId.get(edge.target);
        var dx = b.x - a.x, dy = b.y - a.y;
        var distance = Math.max(1, Math.hypot(dx, dy));
        // Longer lines than before, and noticeably longer when someone hangs
        // off a group by a single connection, so that person sits apart.
        var rest = (neighbors.get(edge.source).length === 1 || neighbors.get(edge.target).length === 1)
          ? 250 : 205;
        var force = (distance - rest) * 0.035;
        a.fx += dx / distance * force; a.fy += dy / distance * force;
        b.fx -= dx / distance * force; b.fy -= dy / distance * force;
      });
      var cooling = 1 - step / 220;
      nodes.forEach(function (node) {
        node.x += Math.max(-14, Math.min(14, node.fx)) * cooling;
        node.y += Math.max(-14, Math.min(14, node.fy)) * cooling;
      });
    }
    // --- The invisible group barrier --------------------------------------
    // A group's core is its 2-core: everyone with at least two friends inside
    // the group. Anyone who only reaches that core through a chain of one-friend
    // links has no connection to the group itself, so the barrier holds them
    // outside it, one ring further out per hop. Without this the spring forces
    // would settle a friend-of-a-friend in the middle of the cluster.
    groups.forEach(function (group) {
      var ids = new Set(group.map(function (node) { return node.profileId; }));
      var core = new Set(ids);
      var peeled = true;
      while (peeled) {
        peeled = false;
        core.forEach(function (id) {
          var inside = neighbors.get(id).filter(function (other) { return core.has(other); }).length;
          if (inside < 2) { core.delete(id); peeled = true; }
        });
      }
      // A plain chain or a pair has no cluster to be outside of, so it keeps
      // the ordinary spring layout.
      if (!core.size) return;

      var cx = 0, cy = 0;
      core.forEach(function (id) { var node = byId.get(id); cx += node.x; cy += node.y; });
      cx /= core.size; cy /= core.size;
      var radius = 0;
      core.forEach(function (id) {
        var node = byId.get(id);
        radius = Math.max(radius, Math.hypot(node.x - cx, node.y - cy));
      });
      var barrier = radius + 70;

      function hopsFromCore(id) {
        var seen = new Set([id]);
        var queue = [[id, 0]];
        for (var i = 0; i < queue.length; i++) {
          if (core.has(queue[i][0])) return queue[i][1];
          neighbors.get(queue[i][0]).forEach(function (other) {
            if (!seen.has(other)) { seen.add(other); queue.push([other, queue[i][1] + 1]); }
          });
        }
        return 1;
      }

      var layers = new Map();
      group.forEach(function (node) {
        if (core.has(node.profileId)) return;
        var hop = hopsFromCore(node.profileId);
        if (!layers.has(hop)) layers.set(hop, []);
        layers.get(hop).push(node);
      });
      Array.from(layers.keys()).sort(function (a, b) { return a - b; }).forEach(function (hop) {
        var layer = layers.get(hop);
        // Keep each person on the side of the group they already reached for,
        // fanned out so same-ring neighbours do not overlap.
        layer.forEach(function (node) { node.angle = Math.atan2(node.y - cy, node.x - cx); });
        layer.sort(function (a, b) {
          return a.angle - b.angle || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0);
        });
        // A minimum angular gap is what actually spaces a ring out when several
        // people hang off the same friend.
        for (var i = 1; i < layer.length; i++) {
          var gap = layer[i].angle - layer[i - 1].angle;
          var wanted = 2 * Math.asin(Math.min(1, 62 / (barrier + 45 + (hop - 1) * 88)));
          if (gap < wanted) layer[i].angle = layer[i - 1].angle + wanted;
        }
        layer.forEach(function (node, index) {
          var r = barrier + 45 + (hop - 1) * 88 + (index % 2) * 34;
          node.x = cx + Math.cos(node.angle) * r;
          node.y = cy + Math.sin(node.angle) * r;
        });
      });
    });
    return nodes;
  }

  var canvas = document.getElementById('social-web-canvas');
  if (!canvas) { window.HTSocialWeb = { layout: layout }; return; }
  var svg = document.getElementById('social-web-svg');
  var scene = document.getElementById('social-web-scene');
  var status = document.getElementById('social-web-status');
  var workspace = document.getElementById('social-web-workspace');
  var picker = document.getElementById('social-web-person');
  var details = document.getElementById('social-web-details');
  var count = document.getElementById('social-web-count');
  var account = null, generation = 0;
  var graph = { nodes: [], edges: [] }, positions = new Map();
  var nodeElements = [], edgeElements = [], selected = '';
  var camera = { x: 0, y: 0, scale: 1 }, fitScale = 1;
  var pointers = new Map(), gesture = null, moved = false, pressedNode = '';

  function element(tag, attrs, text) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function applyCamera() {
    scene.setAttribute('transform', 'translate(' + camera.x + ' ' + camera.y + ') scale(' + camera.scale + ')');
    document.getElementById('social-web-zoom').textContent = Math.round(camera.scale / fitScale * 100) + '%';
  }
  function fit() {
    var nodes = Array.from(positions.values());
    if (!nodes.length) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(function (node) {
      minX = Math.min(minX, node.x - 110); maxX = Math.max(maxX, node.x + 110);
      minY = Math.min(minY, node.y - 55); maxY = Math.max(maxY, node.y + 75);
    });
    fitScale = Math.min(2, 920 / (maxX - minX), 560 / (maxY - minY));
    camera = { scale: fitScale, x: 500 - (minX + maxX) / 2 * fitScale, y: 320 - (minY + maxY) / 2 * fitScale };
    applyCamera();
  }
  function zoom(factor, point) {
    point = point || { x: 500, y: 320 };
    var scale = Math.max(fitScale * 0.25, Math.min(fitScale * 12, camera.scale * factor));
    camera.x = point.x - (point.x - camera.x) * scale / camera.scale;
    camera.y = point.y - (point.y - camera.y) * scale / camera.scale;
    camera.scale = scale;
    applyCamera();
  }
  function point(event) {
    var rect = svg.getBoundingClientRect();
    var scale = Math.min(rect.width / 1000, rect.height / 640) || 1;
    return {
      x: (event.clientX - rect.left - (rect.width - 1000 * scale) / 2) / scale,
      y: (event.clientY - rect.top - (rect.height - 640 * scale) / 2) / scale
    };
  }
  function label(id) {
    var node = positions.get(id);
    return node ? node.displayName || node.profileId : id;
  }

  /**
   * Is this person showing their ID in the graph?
   *
   * A private profile appears as "Anonymous". Printing its profile ID next to
   * that would hand over the one thing anonymity was for: the ID is a bearer
   * handle, so anyone reading it could go and request their schedule. Showing
   * a name is fine -- that is what the student chose -- but the ID is not, so a
   * private profile shows neither.
   *
   * Your own ID is always yours to see, and public profiles already publish it.
   */
  function showsProfileId(id) {
    var node = positions.get(id);
    if (!node) return false;
    if (account && id === account.profileId) return true;
    return node.displayName !== 'Anonymous';
  }
  function select(id) {
    selected = positions.has(id) ? id : '';
    picker.value = selected;
    var connected = new Set([selected]);
    graph.edges.forEach(function (edge) {
      if (edge.source === selected) connected.add(edge.target);
      if (edge.target === selected) connected.add(edge.source);
    });
    nodeElements.forEach(function (item) {
      item.element.classList.toggle('is-selected', item.id === selected);
      item.element.classList.toggle('is-muted', !!selected && !connected.has(item.id));
      item.element.setAttribute('aria-pressed', item.id === selected ? 'true' : 'false');
    });
    edgeElements.forEach(function (item) {
      var active = item.edge.source === selected || item.edge.target === selected;
      item.element.classList.toggle('is-active', !!selected && active);
      item.element.classList.toggle('is-muted', !!selected && !active);
    });
    details.replaceChildren();
    if (!selected) { details.textContent = 'Select a person to explore their connections.'; return; }
    var heading = document.createElement('strong');
    heading.textContent = label(selected) + (account && selected === account.profileId ? ' (you)' : '')
      + (showsProfileId(selected) ? ' · ' + selected : '');
    details.appendChild(heading);
    var giving = graph.edges.filter(function (edge) { return edge.source === selected; }).map(function (edge) { return label(edge.target); });
    var receiving = graph.edges.filter(function (edge) { return edge.target === selected; }).map(function (edge) { return label(edge.source); });
    [ 'Shares with: ' + (giving.join(', ') || 'No visible connections'),
      'Can see: ' + (receiving.join(', ') || 'No visible connections') ].forEach(function (text) {
      var p = document.createElement('p'); p.textContent = text; details.appendChild(p);
    });
  }
  /**
   * The `d` of one edge's path. The straight line is bent around anyone
   * standing between the two people, so a connection flows around an icon and
   * its name instead of passing underneath them.
   */
  function edgePath(a, b, blockers, reciprocal) {
    var dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
    var ux = dx / distance, uy = dy / distance;
    // Reciprocal grants curve on opposite sides, keeping both arrows visible.
    var bend = reciprocal ? 34 : 0;
    var posSide = 0, negSide = 0;
    (blockers || []).forEach(function (other) {
      if (!other || other === a || other === b) return;
      var along = ((other.x - a.x) * ux + (other.y - a.y) * uy) / distance;
      // Near the endpoints the start/end offsets already clear the node.
      if (along <= 0.1 || along >= 0.9) return;
      var px = a.x + ux * along * distance, py = a.y + uy * along * distance;
      var overlap = 58 - Math.hypot(other.x - px, other.y - py);
      if (overlap <= 0) return;
      if ((other.x - px) * -uy + (other.y - py) * ux >= 0) posSide += overlap;
      else negSide += overlap;
    });
    if (posSide || negSide) {
      // Bend away from the busier side, far enough for the curve's apex to
      // clear whatever is standing there (the apex is half the bend).
      var away = posSide >= negSide ? -1 : 1;
      var worse = Math.max(posSide, negSide);
      var better = Math.min(posSide, negSide);
      bend += away * Math.min(190, 2 * Math.max(45, worse - better / 2));
    }
    // The line starts and ends away from each circle, so it clears the name
    // under a node instead of cutting across it.
    return 'M' + (a.x + ux * 34) + ',' + (a.y + uy * 34)
      + ' Q' + ((a.x + b.x) / 2 - uy * bend) + ',' + ((a.y + b.y) / 2 + ux * bend)
      + ' ' + (b.x - ux * 44) + ',' + (b.y - uy * 44);
  }

  function render(data) {
    graph = data;
    positions = new Map(layout(data.nodes, data.edges).map(function (node) { return [node.profileId, node]; }));
    scene.replaceChildren(); nodeElements = []; edgeElements = [];
    picker.replaceChildren(new Option('Everyone', ''));
    var pairs = new Set(data.edges.map(function (edge) { return edge.source + ':' + edge.target; }));
    data.edges.forEach(function (edge) {
      var a = positions.get(edge.source), b = positions.get(edge.target);
      if (!a || !b || a === b) return;
      var path = element('path', {
        d: edgePath(a, b, Array.from(positions.values()), pairs.has(edge.target + ':' + edge.source)),
        class: 'social-web__edge', 'marker-end': 'url(#social-web-arrow)'
      });
      path.appendChild(element('title', {}, label(edge.source) + ' shares their schedule with ' + label(edge.target)));
      scene.appendChild(path); edgeElements.push({ edge: edge, element: path });
    });
    data.nodes.forEach(function (profile) {
      var node = positions.get(profile.profileId);
      var isMe = account && account.profileId === profile.profileId;
      var group = element('g', {
        transform: 'translate(' + node.x + ' ' + node.y + ')',
        class: 'social-web__node' + (isMe ? ' is-you' : ''),
        role: 'button', tabindex: '0', 'aria-label': label(node.profileId) + (showsProfileId(node.profileId) ? ' (' + node.profileId + ')' : '') + (isMe ? ', you' : ''), 'aria-pressed': 'false',
        'data-profile-id': node.profileId
      });
      group.appendChild(element('circle', { r: 24 }));
      var initials = (label(node.profileId).match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
      group.appendChild(element('text', { class: 'social-web__initials', y: 5 }, initials));
      var name = label(node.profileId);
      group.appendChild(element('text', { class: 'social-web__label', y: 45 }, (name.length > 23 ? name.slice(0, 22) + '…' : name) + (isMe ? ' · you' : '')));
      group.appendChild(element('title', {}, name + (showsProfileId(node.profileId) ? ' · ' + node.profileId : '')));
      group.addEventListener('click', function (event) { if (!event.detail) select(selected === node.profileId ? '' : node.profileId); });
      group.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(node.profileId); }
      });
      scene.appendChild(group); nodeElements.push({ id: node.profileId, element: group });
      picker.appendChild(new Option(name + (isMe ? ' (you)' : ''), node.profileId));
    });
    count.textContent = data.nodes.length + ' people · ' + data.edges.length + ' connections';
    fit(); select(selected);
  }
  async function refresh() {
    var token = ++generation;
    if (!account) return;
    status.textContent = 'Loading connections…';
    var result = typeof window.HTAccount.getSocialWeb === 'function'
      ? await window.HTAccount.getSocialWeb() : { ok: false, status: 404 };
    if (token !== generation || !account) return;
    if (!result.ok) {
      workspace.hidden = true;
      scene.replaceChildren(); positions.clear(); graph = { nodes: [], edges: [] };
      picker.replaceChildren(new Option('Everyone', '')); details.textContent = ''; selected = '';
      count.textContent = 'Everyone';
      status.textContent = result.status === 404 ? 'Social web is not available on the server yet.' : 'Could not load the Social web. Try refreshing.';
      // Keep the Refresh control reachable without showing stale connections.
      workspace.hidden = false;
      return;
    }
    render(result.data);
    workspace.hidden = !result.data.nodes.length;
    status.textContent = !result.data.nodes.length ? 'The web is waiting for its first people.'
      : 'Everyone with an account is in the web. Only live sharing connections are shown.';
  }
  function setAccount(me) {
    var changed = !account || !me || account.profileId !== me.profileId || account.displayName !== me.displayName;
    account = me;
    if (!me) {
      generation++; workspace.hidden = true; graph = { nodes: [], edges: [] }; positions.clear();
      scene.replaceChildren(); picker.replaceChildren(new Option('Everyone', ''));
      count.textContent = 'Everyone'; details.textContent = ''; selected = '';
      status.textContent = 'Sign in from Account to explore the Social web.';
    } else if (changed) refresh();
  }
  picker.addEventListener('change', function () {
    select(picker.value);
    var node = positions.get(picker.value);
    if (node) { camera.x = 500 - node.x * camera.scale; camera.y = 320 - node.y * camera.scale; applyCamera(); }
  });
  document.getElementById('social-web-zoom-in').addEventListener('click', function () { zoom(1.25); });
  document.getElementById('social-web-zoom-out').addEventListener('click', function () { zoom(0.8); });
  document.getElementById('social-web-fit').addEventListener('click', fit);
  document.getElementById('social-web-refresh').addEventListener('click', refresh);
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault(); zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), point(event));
  }, { passive: false });
  function startGesture() {
    var list = Array.from(pointers.values());
    gesture = list.length > 1 ? {
      center: { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 },
      distance: Math.max(1, Math.hypot(list[1].x - list[0].x, list[1].y - list[0].y)),
      camera: Object.assign({}, camera)
    } : list.length ? { point: list[0], camera: Object.assign({}, camera) } : null;
  }
  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    var target = event.target.closest('[data-profile-id]');
    if (!pointers.size) { moved = false; pressedNode = target ? target.getAttribute('data-profile-id') : ''; }
    else { moved = true; pressedNode = ''; }
    pointers.set(event.pointerId, point(event)); startGesture();
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, point(event));
    var list = Array.from(pointers.values());
    if (list.length > 1 && gesture.center) {
      moved = true;
      var center = { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 };
      var distance = Math.max(1, Math.hypot(list[1].x - list[0].x, list[1].y - list[0].y));
      var scale = Math.max(fitScale * 0.25, Math.min(fitScale * 12, gesture.camera.scale * distance / gesture.distance));
      camera.scale = scale;
      camera.x = center.x - (gesture.center.x - gesture.camera.x) * scale / gesture.camera.scale;
      camera.y = center.y - (gesture.center.y - gesture.camera.y) * scale / gesture.camera.scale;
    } else if (gesture.point) {
      var dx = list[0].x - gesture.point.x, dy = list[0].y - gesture.point.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      camera.x = gesture.camera.x + dx; camera.y = gesture.camera.y + dy;
    }
    applyCamera();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
    canvas.addEventListener(name, function (event) {
      if (name === 'pointerup' && pointers.size === 1 && !moved && pressedNode) {
        select(selected === pressedNode ? '' : pressedNode);
      }
      pointers.delete(event.pointerId); pressedNode = ''; startGesture();
    });
  });
  canvas.addEventListener('keydown', function (event) {
    var delta = { ArrowLeft: [50, 0], ArrowRight: [-50, 0], ArrowUp: [0, 50], ArrowDown: [0, -50] }[event.key];
    if (delta) { camera.x += delta[0]; camera.y += delta[1]; applyCamera(); }
    else if (event.key === '+' || event.key === '=') zoom(1.25);
    else if (event.key === '-') zoom(0.8);
    else if (event.key === '0') fit();
    else return;
    event.preventDefault();
  });
  window.HTSocialWeb = { setAccount: setAccount, refresh: refresh, layout: layout, edgePath: edgePath };
})();
