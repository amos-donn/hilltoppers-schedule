/** The Social web: a read-only map of who shares their schedule with whom.
 *  No external libraries or third-party requests. */
(function () {
  'use strict';

  // A deterministic spring layout: disconnected groups have separate centers,
  // while linked people attract each other and nearby nodes repel. Dense sharing
  // circles settle together without claiming that a cluster is a friendship.
  //
  // Spacing is measured against the label under each circle, not only the
  // circle: a 23-character name is wider than the icon it sits beneath, so a
  // layout that keeps icons apart still stacks the names on top of each other
  // and reads as one grey tangle.
  function labelWidth(profile) {
    var name = String(profile.displayName || profile.profileId || '');
    return Math.min(23, name.length || 1) * 6;
  }

  function layout(profiles, edges) {
    var nodes = profiles.map(function (profile) {
      return {
        profileId: profile.profileId,
        displayName: profile.displayName,
        nameWidth: labelWidth(profile),
        x: 0, y: 0
      };
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
    var sizes = groups.map(function (group) { return Math.max(240, Math.sqrt(group.length) * 150); });
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
          var r = Math.sqrt(i) * Math.max(112, node.nameWidth * 0.8);
          node.x = cx + Math.cos(angle) * r;
          node.y = cy + Math.sin(angle) * r;
          node.cx = cx; node.cy = cy;
        });
        columnX += radius * 2 + 200;
      });
      rowY += height + 200;
    }
    // Spatial buckets avoid an all-pairs simulation on a whole school's graph.
    for (var step = 0; step < 180; step++) {
      var buckets = new Map();
      nodes.forEach(function (node) {
        node.fx = (node.cx - node.x) * 0.006;
        node.fy = (node.cy - node.y) * 0.006;
        var key = Math.floor(node.x / 300) + ',' + Math.floor(node.y / 300);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(node);
      });
      nodes.forEach(function (node) {
        var bx = Math.floor(node.x / 300), by = Math.floor(node.y / 300);
        for (var gx = bx - 1; gx <= bx + 1; gx++) {
          for (var gy = by - 1; gy <= by + 1; gy++) {
            (buckets.get(gx + ',' + gy) || []).forEach(function (other) {
              if (node === other) return;
              var dx = node.x - other.x, dy = node.y - other.y;
              var distance = Math.max(1, Math.hypot(dx, dy));
              if (distance > 300) return;
              var force = Math.min(24, 7000 / (distance * distance));
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
          ? 360 : 275;
        var force = (distance - rest) * 0.032;
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
          var wanted = 2 * Math.asin(Math.min(1, 88 / (barrier + 60 + (hop - 1) * 100)));
          if (gap < wanted) layer[i].angle = layer[i - 1].angle + wanted;
        }
        layer.forEach(function (node, index) {
          var r = barrier + 60 + (hop - 1) * 100 + (index % 2) * 36;
          node.x = cx + Math.cos(node.angle) * r;
          node.y = cy + Math.sin(node.angle) * r;
        });
      });
    });

    // --- Room to breathe --------------------------------------------------
    // The springs settle people by attraction, not by whether their names fit.
    // This last pass pushes apart any two whose circle or label would touch, so
    // a dense cluster reads as separate people instead of one grey tangle.
    // Labels are at most 23 characters wide, so half-width is capped with them.
    nodes.forEach(function (node) {
      node.halfWidth = Math.max(40, node.nameWidth / 2 + 10);
    });
    for (var pass = 0; pass < 220; pass++) {
      var cells = new Map();
      nodes.forEach(function (node, index) {
        var key = Math.floor(node.x / 320) + ',' + Math.floor(node.y / 320);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      });
      var shifted = false;
      nodes.forEach(function (node, index) {
        var gx0 = Math.floor(node.x / 320), gy0 = Math.floor(node.y / 320);
        for (var gx = gx0 - 1; gx <= gx0 + 1; gx++) {
          for (var gy = gy0 - 1; gy <= gy0 + 1; gy++) {
            (cells.get(gx + ',' + gy) || []).forEach(function (otherIndex) {
              if (otherIndex <= index) return;
              var other = nodes[otherIndex];
              var minX = node.halfWidth + other.halfWidth + 18;
              // Circle above, label below, plus a line of air between them.
              var minY = 104;
              var dx = other.x - node.x, dy = other.y - node.y;
              if (Math.abs(dx) >= minX || Math.abs(dy) >= minY) return;
              var pushX = Math.min(12, (minX - Math.abs(dx)) / 2);
              var pushY = Math.min(12, (minY - Math.abs(dy)) / 2);
              // Separate along whichever axis needs less travel, so names slide
              // past each other instead of shoving the whole cluster sideways.
              if (pushX < pushY) {
                var sx = dx === 0 ? (index % 2 ? 1 : -1) : (dx < 0 ? -1 : 1);
                node.x -= sx * pushX; other.x += sx * pushX;
              } else {
                var sy = dy === 0 ? (index % 2 ? 1 : -1) : (dy < 0 ? -1 : 1);
                node.y -= sy * pushY; other.y += sy * pushY;
              }
              shifted = true;
            });
          }
        }
      });
      if (!shifted) break;
    }
    return nodes;
  }

  /**
   * Collapse directional grants into drawn connections: one line per pair.
   *
   * Two people who share with each other are a single connection with an
   * arrowhead at each end. Drawing each grant separately puts a second,
   * near-identical curve on the first one and turns a mutual pair into a
   * scribble that hides the rest of the graph.
   */
  function links(edges) {
    var byPair = new Map();
    (edges || []).forEach(function (edge) {
      if (!edge || edge.source === edge.target) return;
      var key = edge.source < edge.target
        ? edge.source + ':' + edge.target : edge.target + ':' + edge.source;
      if (!byPair.has(key)) byPair.set(key, { source: edge.source, target: edge.target, mutual: false });
      else byPair.get(key).mutual = true;
    });
    return Array.from(byPair.values());
  }

  var canvas = document.getElementById('social-web-canvas');
  if (!canvas) { window.HTSocialWeb = { layout: layout, links: links }; return; }
  var svg = document.getElementById('social-web-svg');
  var scene = document.getElementById('social-web-scene');
  var status = document.getElementById('social-web-status');
  var workspace = document.getElementById('social-web-workspace');
  var findCard = document.getElementById('social-web-find');
  var findToggle = document.getElementById('social-web-find-toggle');
  var findPanel = document.getElementById('social-web-find-panel');
  var findInput = document.getElementById('social-web-find-input');
  var findEmpty = document.getElementById('social-web-find-empty');
  var peopleList = document.getElementById('social-web-people-list');
  var details = document.getElementById('social-web-details');
  var count = document.getElementById('social-web-count');
  var account = null, generation = 0;
  var graph = { nodes: [], edges: [] }, positions = new Map();
  var nodeElements = [], edgeElements = [], peopleRows = [], selected = '';
  var camera = { x: 0, y: 0, scale: 1 }, fitScale = 1;
  var view = { w: 1000, h: 640 };
  var pointers = new Map(), gesture = null, moved = false, pressedNode = '';

  function element(tag, attrs, text) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // --- Drawing the map -----------------------------------------------------
  //
  // A pointer move is not a frame. A trackpad or a high-polling mouse reports
  // several moves per frame, and this used to write the transform, re-read the
  // layout and reprint the zoom readout for every one of them -- more redraws
  // of the whole map than the browser can keep up with. The camera is written
  // once per animation frame now, with wherever the gesture ended up.
  var zoomOutput = document.getElementById('social-web-zoom');
  var canvasRect = null, cameraFrame = 0, cameraPending = false, stillTimer = 0;

  function frame(callback) {
    return window.requestAnimationFrame ? window.requestAnimationFrame(callback)
      : window.setTimeout(callback, 16);
  }
  // Measuring the SVG is layout work, so it is done once per layout instead of
  // once per move. syncView() and a window resize forget the measurement.
  function canvasBox() {
    if (!canvasRect) canvasRect = svg.getBoundingClientRect();
    return canvasRect;
  }
  function forgetBox() { canvasRect = null; }

  function paintCamera() {
    cameraFrame = 0;
    if (!cameraPending) return;
    cameraPending = false;
    scene.setAttribute('transform', 'translate(' + camera.x + ' ' + camera.y + ') scale(' + camera.scale + ')');
    var percent = Math.round(camera.scale / fitScale * 100) + '%';
    if (zoomOutput.textContent !== percent) zoomOutput.textContent = percent;
  }
  function applyCamera() {
    cameraPending = true;
    if (!cameraFrame) cameraFrame = frame(paintCamera);
  }

  // While a gesture is running the scene is promoted to its own layer, so the
  // browser moves the map it has already drawn instead of re-drawing every
  // line, arrowhead and name for each step. Letting go of that layer shortly
  // after the last move is what makes the map crisp again at the new zoom.
  var MOVE_IDLE_MS = 160;
  function moving() {
    svg.classList.add('is-moving');
    clearTimeout(stillTimer);
    stillTimer = setTimeout(function () {
      stillTimer = 0;
      svg.classList.remove('is-moving');
    }, MOVE_IDLE_MS);
  }
  // The canvas is the whole tab, so the drawing area follows its aspect ratio
  // instead of letterboxing a fixed 1000x640 frame. jsdom reports a zero-size
  // rect, in which case the default frame stays in place.
  function syncView() {
    forgetBox();
    var rect = svg && svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      view = {
        w: 1000,
        h: Math.max(360, Math.min(1800, Math.round(1000 * rect.height / rect.width)))
      };
    } else {
      view = { w: 1000, h: 640 };
    }
    if (svg) svg.setAttribute('viewBox', '0 0 ' + view.w + ' ' + view.h);
  }
  function fit() {
    syncView();
    var nodes = Array.from(positions.values());
    if (!nodes.length) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(function (node) {
      minX = Math.min(minX, node.x - 110); maxX = Math.max(maxX, node.x + 110);
      minY = Math.min(minY, node.y - 55); maxY = Math.max(maxY, node.y + 75);
    });
    fitScale = Math.min(2, (view.w - 80) / (maxX - minX), (view.h - 80) / (maxY - minY));
    camera = { scale: fitScale, x: view.w / 2 - (minX + maxX) / 2 * fitScale, y: view.h / 2 - (minY + maxY) / 2 * fitScale };
    applyCamera();
  }
  function zoom(factor, point) {
    point = point || { x: view.w / 2, y: view.h / 2 };
    var scale = Math.max(fitScale * 0.25, Math.min(fitScale * 12, camera.scale * factor));
    camera.x = point.x - (point.x - camera.x) * scale / camera.scale;
    camera.y = point.y - (point.y - camera.y) * scale / camera.scale;
    camera.scale = scale;
    applyCamera();
  }
  function point(event) {
    var rect = canvasBox();
    var scale = Math.min(rect.width / view.w, rect.height / view.h) || 1;
    return {
      x: (event.clientX - rect.left - (rect.width - view.w * scale) / 2) / scale,
      y: (event.clientY - rect.top - (rect.height - view.h * scale) / 2) / scale
    };
  }
  function label(id) {
    var node = positions.get(id);
    return node ? node.displayName || node.profileId : id;
  }

  /**
   * Is this person showing their ID in the graph?
   *
   * A profile ID is a bearer handle: whoever reads it can ask the server for
   * that person's schedule. So it is printed only when the person has actually
   * shared their schedule with you, which is the one case where the ID is the
   * thing the share is for, plus on your own entry, which is yours to see.
   *
   * A profile that chose "Anonymous" keeps its ID to itself even then: hiding
   * it is what that choice was about, and a share does not undo it. A name is
   * still fine to show -- that is what the student chose to display.
   */
  function showsProfileId(id) {
    var node = positions.get(id);
    if (!node) return false;
    if (account && id === account.profileId) return true;
    if (node.displayName === 'Anonymous' || !account) return false;
    return graph.edges.some(function (edge) {
      return edge.source === id && edge.target === account.profileId;
    });
  }
  function select(id) {
    selected = positions.has(id) ? id : '';
    markSelectedRow();
    var connected = new Set([selected]);
    graph.edges.forEach(function (edge) {
      if (edge.source === selected) connected.add(edge.target);
      if (edge.target === selected) connected.add(edge.source);
    });
    // Only touch what actually changes. A click used to rewrite a class and
    // aria-pressed on every person and every line, which on a school-sized web
    // is thousands of writes and a full re-style for one selection.
    nodeElements.forEach(function (item) {
      var isSelected = item.id === selected;
      var isMuted = !!selected && !connected.has(item.id);
      if (item.selected !== isSelected) {
        item.element.classList.toggle('is-selected', isSelected);
        item.element.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        item.selected = isSelected;
      }
      if (item.muted !== isMuted) {
        item.element.classList.toggle('is-muted', isMuted);
        item.muted = isMuted;
      }
    });
    edgeElements.forEach(function (item) {
      var isActive = !!selected && (item.ids[0] === selected || item.ids[1] === selected);
      var isMuted = !!selected && !isActive;
      if (item.active !== isActive) {
        item.element.classList.toggle('is-active', isActive);
        item.active = isActive;
      }
      if (item.muted !== isMuted) {
        item.element.classList.toggle('is-muted', isMuted);
        item.muted = isMuted;
      }
    });
    details.replaceChildren();
    if (!selected) { details.textContent = ''; details.hidden = true; return; }
    details.hidden = false;
    var heading = document.createElement('strong');
    heading.textContent = label(selected) + (account && selected === account.profileId ? ' (you)' : '')
      + (showsProfileId(selected) ? ' · ' + selected : '');
    details.appendChild(heading);
    var giving = graph.edges.filter(function (edge) { return edge.source === selected; })
      .map(function (edge) { return { id: edge.target, name: label(edge.target) }; });
    var receiving = graph.edges.filter(function (edge) { return edge.target === selected; })
      .map(function (edge) { return { id: edge.source, name: label(edge.source) }; });
    // Two sections, each introduced by a pill above the list it describes, so
    // the box reads as "this is who they share with" and "this is who they can
    // see" instead of two lines of running text. Everyone in those lists is a
    // pill of their own that opens their card, so the web can be walked from
    // here instead of hunting for their circle on a crowded map.
    [ ['Shares with', 'giving', giving], ['Can see', 'receiving', receiving] ].forEach(function (section) {
      var block = document.createElement('section');
      block.className = 'social-web__details-block';
      var pill = document.createElement('span');
      pill.className = 'social-web__pill social-web__pill--' + section[1];
      pill.textContent = section[0];
      var list = document.createElement('div');
      list.className = 'social-web__people';
      if (!section[2].length) {
        var none = document.createElement('p');
        none.textContent = 'No visible connections';
        list.appendChild(none);
      }
      section[2].forEach(function (person) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'social-web__person';
        chip.textContent = person.name;
        chip.addEventListener('click', function () {
          select(person.id);
          // The list is rebuilt for the new person, so the chip that was
          // clicked is gone; without this a keyboard would drop back to the
          // top of the page instead of staying with the card it just opened.
          if (details.focus) details.focus();
        });
        list.appendChild(chip);
      });
      block.appendChild(pill);
      block.appendChild(document.createTextNode(' '));
      block.appendChild(list);
      details.appendChild(block);
    });
  }
  function cubicPoint(p0, p1, p2, p3, t) {
    var u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    };
  }

  function segmentHitsCircle(from, to, center, radius) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var length2 = dx * dx + dy * dy || 1;
    var t = Math.max(0, Math.min(1, ((center.x - from.x) * dx + (center.y - from.y) * dy) / length2));
    return Math.hypot(from.x + dx * t - center.x, from.y + dy * t - center.y) < radius;
  }

  // Liang-Barsky: does the segment touch the box at all?
  function segmentHitsBox(from, to, box) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var edges = [-dx, dx, -dy, dy];
    var bounds = [from.x - box.left, box.right - from.x, from.y - box.top, box.bottom - from.y];
    var enter = 0, exit = 1;
    for (var i = 0; i < 4; i++) {
      if (!edges[i]) { if (bounds[i] < 0) return false; continue; }
      var t = bounds[i] / edges[i];
      if (edges[i] < 0) {
        if (t > exit) return false;
        if (t > enter) enter = t;
      } else {
        if (t < enter) return false;
        if (t < exit) exit = t;
      }
    }
    return true;
  }

  // What a line must not cross: the icon circle and the name printed under it.
  var ICON_RADIUS = 26;
  function labelBox(node) {
    var half = Math.max(12, (node.nameWidth || 60) / 2);
    return { left: node.x - half, right: node.x + half, top: node.y + 33, bottom: node.y + 49 };
  }

  // The arrowhead's tip sits this far from a person's centre, and the line
  // runs straight at the centre for the last stretch before it. Both are fixed
  // so every head looks the same distance from the person and points at them,
  // however much the middle of the line had to bend.
  var EDGE_GAP = 29;
  var EDGE_STUB = 12;

  /**
   * The `d` of one edge's path. Only the middle bends around anyone standing
   * between the two people; both ends are straight, radial runs into the
   * circles, which is what keeps the arrowheads aimed at the people.
   */
  function edgePath(a, b, blockers) {
    var dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
    var ux = dx / distance, uy = dy / distance;
    // Two people closer than two gaps cannot both keep it; short edges give up
    // a little distance rather than crossing each other.
    var gap = Math.min(EDGE_GAP, distance / 2 - 6);
    var stub = Math.min(EDGE_STUB, Math.max(0, distance / 2 - gap) * 0.5);
    var sx = a.x + ux * gap, sy = a.y + uy * gap;
    var ex = b.x - ux * gap, ey = b.y - uy * gap;
    var s2x = sx + ux * stub, s2y = sy + uy * stub;
    var e2x = ex - ux * stub, e2y = ey - uy * stub;
    // Control reach along the chord. It makes the curve leave and rejoin the
    // chord flat, so the stubs join without a kink.
    var k = Math.max(20, Math.min(90, distance * 0.25));

    // Only someone the straight line would actually run through -- an icon or
    // the name under it -- is worth bending for. Merely passing near leaves
    // the edge straight, which is most of them.
    var crossed = [];
    (blockers || []).forEach(function (other) {
      if (!other || other === a || other === b) return;
      var along = ((other.x - a.x) * ux + (other.y - a.y) * uy) / distance;
      // The stubs are straight, so nothing sitting behind them can be dodged.
      if (along * distance < gap + stub + 6) return;
      if ((1 - along) * distance < gap + stub + 6) return;
      var start = { x: a.x, y: a.y }, end = { x: b.x, y: b.y };
      if (segmentHitsCircle(start, end, other, ICON_RADIUS)
        || segmentHitsBox(start, end, labelBox(other))) {
        crossed.push(other);
      }
    });

    var bend = 0;
    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (crossed.length) {
      // Move away from the busier side and take the shallowest bow that
      // actually clears every icon and name on the way.
      var side = 0;
      crossed.forEach(function (other) {
        side += (other.x - a.x) * -uy + (other.y - a.y) * ux;
      });
      var away = side >= 0 ? -1 : 1;
      var steps = [12, 18, 26, 36, 48, 62, 78, 96, 116];
      function curvePoints(bendValue) {
        var cx = (a.x + b.x) / 2 - uy * bendValue;
        var cy = (a.y + b.y) / 2 + ux * bendValue;
        var pts = [{ x: sx, y: sy }, { x: s2x, y: s2y }], i, t;
        for (i = 1; i <= 12; i++) {
          t = i / 12;
          pts.push(cubicPoint({ x: s2x, y: s2y }, { x: s2x + ux * k, y: s2y + uy * k },
            { x: cx - ux * k, y: cy - uy * k }, { x: cx, y: cy }, t));
        }
        for (i = 1; i <= 12; i++) {
          t = i / 12;
          pts.push(cubicPoint({ x: cx, y: cy }, { x: cx + ux * k, y: cy + uy * k },
            { x: e2x - ux * k, y: e2y - uy * k }, { x: e2x, y: e2y }, t));
        }
        pts.push({ x: ex, y: ey });
        return pts;
      }
      function clears(bendValue) {
        var pts = curvePoints(bendValue);
        for (var i = 0; i < crossed.length; i++) {
          var other = crossed[i], box = labelBox(other);
          for (var j = 1; j < pts.length; j++) {
            if (segmentHitsCircle(pts[j - 1], pts[j], other, ICON_RADIUS)) return false;
            if (segmentHitsBox(pts[j - 1], pts[j], box)) return false;
          }
        }
        return true;
      }
      [away, -away].forEach(function (dir) {
        if (bend) return;
        for (var i = 0; i < steps.length; i++) {
          if (clears(dir * steps[i])) { bend = dir * steps[i]; return; }
        }
      });
      // Nothing cleared in either direction: bow as far as allowed rather than
      // run straight through someone.
      if (!bend) bend = away * steps[steps.length - 1];
      mx = (a.x + b.x) / 2 - uy * bend;
      my = (a.y + b.y) / 2 + ux * bend;
    }
    return 'M' + sx + ',' + sy
      + ' L' + s2x + ',' + s2y
      + ' C' + (s2x + ux * k) + ',' + (s2y + uy * k)
      + ' ' + (mx - ux * k) + ',' + (my - uy * k)
      + ' ' + mx + ',' + my
      + ' C' + (mx + ux * k) + ',' + (my + uy * k)
      + ' ' + (e2x - ux * k) + ',' + (e2y - uy * k)
      + ' ' + e2x + ',' + e2y
      + ' L' + ex + ',' + ey;
  }

  // --- The people search ---------------------------------------------------
  //
  // This was a <select> that named the current pick and listed everyone under
  // it. It is now the search card the toolbar shows: a pill reading "Search"
  // that opens into a floating card with a field and the same people under it,
  // so a name can be typed instead of scrolled for. Nothing in it names a
  // person or says "everyone", and the pill keeps its place while the card is
  // open so the controls beside it do not jump.

  function clearPeople() {
    peopleRows = [];
    if (peopleList) peopleList.replaceChildren();
    if (findInput) findInput.value = '';
  }

  function markSelectedRow() {
    peopleRows.forEach(function (row) {
      if (row.id === selected) row.element.setAttribute('aria-selected', 'true');
      else row.element.removeAttribute('aria-selected');
    });
  }

  function addPersonRow(profile) {
    if (!peopleList) return;
    var isMe = account && account.profileId === profile.profileId;
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-card__option';
    row.setAttribute('role', 'option');
    row.setAttribute('data-profile-id', profile.profileId);
    row.textContent = label(profile.profileId) + (isMe ? ' (you)' : '');
    row.addEventListener('click', function () { choosePerson(profile.profileId); });
    peopleList.appendChild(row);
    peopleRows.push({ id: profile.profileId, name: row.textContent.toLowerCase(), element: row });
  }

  function visibleRows() {
    return peopleRows.filter(function (row) { return !row.element.hidden; });
  }

  function filterPeople() {
    var query = findInput ? findInput.value.trim().toLowerCase() : '';
    var shown = 0;
    peopleRows.forEach(function (row) {
      var match = !query || row.name.indexOf(query) !== -1;
      row.element.hidden = !match;
      if (match) shown++;
    });
    if (findEmpty) findEmpty.hidden = shown > 0 || !query;
    // An empty list still draws its border and padding, so hide it outright
    // when nothing is left to show.
    if (peopleList) peopleList.hidden = shown === 0;
  }

  function centreOn(id) {
    var node = positions.get(id);
    if (!node) return;
    camera.x = view.w / 2 - node.x * camera.scale;
    camera.y = view.h / 2 - node.y * camera.scale;
    applyCamera();
  }

  function openFind() {
    if (!findCard || findCard.classList.contains('is-open')) return;
    findCard.classList.add('is-open');
    findToggle.setAttribute('aria-expanded', 'true');
    findPanel.hidden = false;
    findInput.value = '';
    filterPeople();
    findInput.focus();
  }

  function closeFind() {
    if (!findCard || !findCard.classList.contains('is-open')) return;
    findCard.classList.remove('is-open');
    findToggle.setAttribute('aria-expanded', 'false');
    findPanel.hidden = true;
  }

  function choosePerson(id) {
    select(selected === id ? '' : id);
    if (selected) centreOn(selected);
    closeFind();
    if (findToggle) findToggle.focus();
  }

  function render(data) {
    graph = data;
    positions = new Map(layout(data.nodes, data.edges).map(function (node) { return [node.profileId, node]; }));
    scene.replaceChildren(); nodeElements = []; edgeElements = [];
    clearPeople();
    links(data.edges).forEach(function (link) {
      var a = positions.get(link.source), b = positions.get(link.target);
      if (!a || !b || a === b) return;
      var attrs = {
        d: edgePath(a, b, Array.from(positions.values())),
        class: 'social-web__edge' + (link.mutual ? ' is-mutual' : ''),
        'marker-end': 'url(#social-web-arrow)'
      };
      if (link.mutual) attrs['marker-start'] = 'url(#social-web-arrow)';
      var path = element('path', attrs);
      path.appendChild(element('title', {}, link.mutual
        ? label(link.source) + ' and ' + label(link.target) + ' share their schedules with each other'
        : label(link.source) + ' shares their schedule with ' + label(link.target)));
      scene.appendChild(path);
      edgeElements.push({ ids: [link.source, link.target], element: path });
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
      addPersonRow(node);
    });
    count.textContent = data.nodes.length + ' people · ' + edgeElements.length + ' connections';
    count.hidden = false;
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
      clearPeople(); closeFind(); details.textContent = ''; details.hidden = true; selected = '';
      count.textContent = ''; count.hidden = true;
      status.textContent = result.status === 404 ? 'Social web is not available on the server yet.' : 'Could not load the Social web. Try refreshing.';
      // Keep the Refresh control reachable without showing stale connections.
      workspace.hidden = false;
      return;
    }
    render(result.data);
    workspace.hidden = !result.data.nodes.length;
    status.textContent = !result.data.nodes.length ? 'The web is waiting for its first people.'
      : '';
  }
  function setAccount(me) {
    var changed = !account || !me || account.profileId !== me.profileId || account.displayName !== me.displayName;
    account = me;
    if (!me) {
      generation++; workspace.hidden = true; graph = { nodes: [], edges: [] }; positions.clear();
      scene.replaceChildren(); clearPeople(); closeFind();
      count.textContent = ''; count.hidden = true; details.textContent = ''; details.hidden = true; selected = '';
      status.textContent = 'Sign in from Account to explore the Social web.';
    } else if (changed) refresh();
  }
  if (findCard) {
    findToggle.addEventListener('click', function () {
      if (findCard.classList.contains('is-open')) closeFind(); else openFind();
    });
    findInput.addEventListener('input', filterPeople);
    findInput.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFind();
        findToggle.focus();
      } else if (event.key === 'Enter') {
        // The first match is the one a typed search is about most of the time.
        var first = visibleRows()[0];
        if (!first) return;
        event.preventDefault();
        choosePerson(first.id);
      }
    });
    // The card floats over the map, so a press anywhere else puts it away.
    document.addEventListener('pointerdown', function (event) {
      if (findCard.classList.contains('is-open') && !findCard.contains(event.target)) closeFind();
    });
  }
  document.getElementById('social-web-zoom-in').addEventListener('click', function () { zoom(1.25); });
  document.getElementById('social-web-zoom-out').addEventListener('click', function () { zoom(0.8); });
  document.getElementById('social-web-fit').addEventListener('click', fit);
  document.getElementById('social-web-refresh').addEventListener('click', refresh);
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    moving();
    zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003), point(event));
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
    moving();
    var target = event.target.closest('[data-profile-id]');
    if (!pointers.size) { moved = false; pressedNode = target ? target.getAttribute('data-profile-id') : ''; }
    else { moved = true; pressedNode = ''; }
    pointers.set(event.pointerId, point(event)); startGesture();
    if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', function (event) {
    if (!pointers.has(event.pointerId) || !gesture) return;
    pointers.set(event.pointerId, point(event));
    moving();
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
    moving();
    event.preventDefault();
  });
  // The map is sized to its tab, so a window resize needs a fresh fit rather
  // than leaving the old camera framing a different aspect ratio.
  window.addEventListener('resize', function () { forgetBox(); fit(); });
  window.HTSocialWeb = { setAccount: setAccount, refresh: refresh, layout: layout, edgePath: edgePath, links: links };
})();
