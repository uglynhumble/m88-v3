/*!
 * М88 — отправка заявок прямо с сайта (без почтовой программы).
 * Один скрипт на обе страницы. Синтаксис ES5 — работает в Safari 9+,
 * Chrome/Edge/Firefox любых версий, iOS 9+, Android 5+, IE11.
 *
 * Разметка:
 *   <form data-m88form data-endpoint="/send.php" data-page="Главная"> … </form>
 * Необязательные элементы внутри формы:
 *   [data-dropzone]  — зона перетаскивания
 *   input[type=file] — выбор файлов
 *   [data-filelist]  — контейнер под чипсы выбранных файлов
 *   [data-note]      — подпись под формой (текст меняется по состоянию)
 */
(function () {
  'use strict';

  var MAX_FILES = 5;
  // Общий предел вложений. Хостинг может задать свой, объявив
  // window.M88_MAX_TOTAL_MB = 3.5 до подключения этого файла (лимит Vercel).
  var MAX_TOTAL = (window.M88_MAX_TOTAL_MB || 20) * 1024 * 1024;
  var ALLOWED = ['pdf', 'dwg', 'dxf', 'step', 'stp', 'stl', 'iges', 'igs', 'x_t',
    'sldprt', 'sldasm', 'zip', 'rar', '7z', 'jpg', 'jpeg', 'png',
    'doc', 'docx', 'xls', 'xlsx'];

  function each(list, fn) {
    for (var i = 0; i < list.length; i++) fn(list[i], i);
  }
  function fmtSize(b) {
    if (b < 1024) return b + ' Б';
    if (b < 1048576) return Math.round(b / 1024) + ' КБ';
    return (b / 1048576).toFixed(1) + ' МБ';
  }
  function extOf(n) {
    var i = n.lastIndexOf('.');
    return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ------------------------------------------------------------------------
   * Телефон: +7 подставляется сам, цифры раскладываются в +7 (999) 123-45-67.
   * Если человек начинает с «+» и другого кода страны — не мешаем: у М88 есть
   * китайские и европейские контрагенты.
   * --------------------------------------------------------------------- */
  function isForeign(v) {
    return v.charAt(0) === '+' && v.charAt(1) && v.charAt(1) !== '7';
  }

  function formatRu(digits) {
    // digits — только цифры, без кода страны
    var out = '+7';
    if (digits.length) out += ' (' + digits.slice(0, 3);
    if (digits.length >= 3) out += ')';
    if (digits.length > 3) out += ' ' + digits.slice(3, 6);
    if (digits.length > 6) out += '-' + digits.slice(6, 8);
    if (digits.length > 8) out += '-' + digits.slice(8, 10);
    return out;
  }

  function normalize(value) {
    if (isForeign(value)) return '+' + value.replace(/[^\d]/g, '').slice(0, 15);
    var d = value.replace(/\D/g, '');
    if (d.charAt(0) === '8' || d.charAt(0) === '7') d = d.slice(1);   // 8… и 7… — тот же +7
    return formatRu(d.slice(0, 10));
  }

  function countDigits(s) { return (s.replace(/\D/g, '') || '').length; }

  function attachPhone(input) {
    function reformat(keepCaret) {
      var before = input.value;
      var caret = input.selectionStart;
      var digitsBefore = (typeof caret === 'number')
        ? countDigits(before.slice(0, caret)) : null;
      var after = normalize(before);
      if (after === before) return;
      input.value = after;
      if (keepCaret && digitsBefore !== null && input.setSelectionRange) {
        // ставим курсор после того же количества цифр
        var seen = 0, pos = after.length;
        if (digitsBefore > 0) {
          for (var i = 0; i < after.length; i++) {
            if (/\d/.test(after.charAt(i))) {
              seen++;
              if (seen === digitsBefore) { pos = i + 1; break; }
            }
          }
        }
        try { input.setSelectionRange(pos, pos); } catch (e) { /* не критично */ }
      }
    }

    input.addEventListener('focus', function () {
      if (!input.value.replace(/\s/g, '')) {
        input.value = '+7 (';
        if (input.setSelectionRange) {
          setTimeout(function () {
            try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
          }, 0);
        }
      }
    }, false);

    input.addEventListener('input', function () { reformat(true); }, false);
    input.addEventListener('paste', function () { setTimeout(function () { reformat(false); }, 0); }, false);

    input.addEventListener('blur', function () {
      // «+7 (» без единой цифры — очищаем, чтобы плейсхолдер вернулся
      if (countDigits(input.value) <= 1 && !isForeign(input.value)) input.value = '';
    }, false);
  }

  function init(form) {
    var endpoint = form.getAttribute('data-endpoint') || 'send.php';
    var pageName = form.getAttribute('data-page') || document.title;
    var dropzone = form.querySelector('[data-dropzone]');
    var fileInput = form.querySelector('input[type=file]');
    var fileList = form.querySelector('[data-filelist]');
    var note = form.querySelector('[data-note]');
    var button = form.querySelector('button[type=submit], input[type=submit]');
    var noteBase = note ? note.textContent : '';
    var chosen = [];
    var busy = false;

    // ── служебные поля (honeypot + отметка времени) ──────────────────────────
    var trap = el('div', 'm88-trap');
    trap.setAttribute('aria-hidden', 'true');
    trap.innerHTML =
      '<label>Не заполняйте это поле<input type="text" name="website" tabindex="-1" autocomplete="off"></label>' +
      '<input type="text" name="fax" tabindex="-1" autocomplete="off">';
    form.appendChild(trap);

    var started = el('input');
    started.type = 'hidden';
    started.name = 'form_started';
    started.value = String(Date.now());
    form.appendChild(started);

    var pageField = el('input');
    pageField.type = 'hidden';
    pageField.name = 'page';
    pageField.value = pageName;
    form.appendChild(pageField);

    // ── статус ──────────────────────────────────────────────────────────────
    var status = el('div', 'm88-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    if (button && button.parentNode) button.parentNode.insertBefore(status, button.nextSibling);
    else form.appendChild(status);

    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'm88-status' + (text ? ' is-' + (kind || 'info') : '');
    }

    // ── файлы ───────────────────────────────────────────────────────────────
    function syncNote() {
      if (!note) return;
      note.textContent = chosen.length
        ? 'Файлы (' + chosen.length + ') уйдут вместе с заявкой. ' + noteBase
        : noteBase;
    }

    function render() {
      if (!fileList) { syncNote(); return; }
      while (fileList.firstChild) fileList.removeChild(fileList.firstChild);
      each(chosen, function (f, idx) {
        var chip = el('div', 'm88-chip');
        chip.appendChild(el('span', 'm88-chip-name', f.name));
        chip.appendChild(el('span', 'm88-chip-size', fmtSize(f.size)));
        var del = el('button', 'm88-chip-del', '×');
        del.type = 'button';
        del.setAttribute('aria-label', 'Удалить файл ' + f.name);
        del.onclick = function () { chosen.splice(idx, 1); render(); };
        chip.appendChild(del);
        fileList.appendChild(chip);
      });
      syncNote();
    }

    function addFiles(list) {
      var msg = '';
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (chosen.length >= MAX_FILES) { msg = 'Можно приложить не более ' + MAX_FILES + ' файлов'; break; }
        if (ALLOWED.indexOf(extOf(f.name)) < 0) { msg = 'Формат «' + (extOf(f.name) || '?') + '» не поддерживается'; continue; }
        var dup = false;
        for (var j = 0; j < chosen.length; j++) {
          if (chosen[j].name === f.name && chosen[j].size === f.size) dup = true;
        }
        if (dup) continue;
        var total = 0;
        for (var k = 0; k < chosen.length; k++) total += chosen[k].size;
        if (total + f.size > MAX_TOTAL) { msg = 'Суммарный размер файлов больше ' + (MAX_TOTAL / 1048576).toFixed(MAX_TOTAL % 1048576 ? 1 : 0).replace('.', ',') + ' МБ'; continue; }
        chosen.push(f);
      }
      render();
      if (msg) setStatus(msg, 'warn');
      else if (status.className.indexOf('is-warn') >= 0) setStatus('');
    }

    each(form.querySelectorAll('input[data-phone]'), attachPhone);

    if (fileInput) {
      fileInput.setAttribute('multiple', 'multiple');
      fileInput.onchange = function () {
        if (fileInput.files) addFiles(fileInput.files);
        try { fileInput.value = ''; } catch (e) { /* старые IE */ }
      };
    }

    if (dropzone) {
      dropzone.onclick = function () { if (fileInput) fileInput.click(); };
      dropzone.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          if (fileInput) fileInput.click();
        }
      };
      each(['dragenter', 'dragover'], function (ev) {
        dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('drag'); }, false);
      });
      each(['dragleave', 'drop'], function (ev) {
        dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('drag'); }, false);
      });
      dropzone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
      }, false);
    }

    // Страница целиком не должна открывать файл, если промахнулись мимо зоны
    each(['dragover', 'drop'], function (ev) {
      window.addEventListener(ev, function (e) {
        if (dropzone && dropzone.contains(e.target)) return;
        e.preventDefault();
      }, false);
    });

    render();

    // ── экран «отправлено» ──────────────────────────────────────────────────
    function showSuccess(ticket, skipped) {
      var box = el('div', 'm88-done');
      box.setAttribute('role', 'status');
      box.appendChild(el('div', 'm88-done-mark', '✓'));
      box.appendChild(el('h4', 'm88-done-title', 'Заявка отправлена'));
      box.appendChild(el('p', 'm88-done-text',
        'Инженер М88 свяжется с вами в рабочее время — обычно в течение одного рабочего дня.'));
      // молча терять вложения нельзя — человек должен узнать, что файл не ушёл
      if (skipped && skipped.length) {
        box.appendChild(el('p', 'm88-done-warn',
          'Не приложены: ' + skipped.join('; ') + '. Пришлите эти файлы ответом на письмо '
          + 'или ссылкой на облако.'));
      }
      if (ticket) box.appendChild(el('div', 'm88-done-ticket', 'Номер обращения: ' + ticket));
      var again = el('button', 'm88-done-again', 'Отправить ещё одну заявку');
      again.type = 'button';
      again.onclick = function () {
        box.parentNode.replaceChild(form, box);
        form.reset();
        chosen = [];
        render();
        setStatus('');
        // form.reset() сбрасывает hidden-поля к пустому defaultValue —
        // возвращаем их вручную, иначе вторая заявка уйдёт без страницы
        started.value = String(Date.now());
        pageField.value = pageName;
        if (button) { button.disabled = false; button.innerHTML = buttonHtml; }
      };
      box.appendChild(again);
      if (form.parentNode) form.parentNode.replaceChild(box, form);
    }

    var buttonHtml = button ? button.innerHTML : '';

    // ── отправка ────────────────────────────────────────────────────────────
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;

      // Проверка обязательных полей (в т.ч. для браузеров без checkValidity)
      var required = form.querySelectorAll('[required]');
      for (var i = 0; i < required.length; i++) {
        var f = required[i];
        var empty = (f.type === 'checkbox') ? !f.checked : !String(f.value).replace(/^\s+|\s+$/g, '');
        if (empty) {
          setStatus('Заполните обязательные поля.', 'error');
          if (f.focus) f.focus();
          return;
        }
      }

      // Телефон: российский номер должен быть полным
      var phone = form.querySelector('input[data-phone]');
      if (phone && phone.value) {
        var enough = isForeign(phone.value) ? countDigits(phone.value) >= 8 : countDigits(phone.value) >= 11;
        if (!enough) {
          setStatus('Проверьте номер телефона — не хватает цифр.', 'error');
          if (phone.focus) phone.focus();
          return;
        }
      }

      if (!window.FormData || !window.XMLHttpRequest) {
        setStatus('Ваш браузер слишком старый для отправки формы. Напишите на zakaz@m88.su.', 'error');
        return;
      }

      var fd = new FormData();
      var data = {};                       // те же поля обычным объектом —
      each(form.querySelectorAll('input, textarea, select'), function (f) {
        if (!f.name || f.type === 'file' || f.type === 'submit') return;
        if ((f.type === 'checkbox' || f.type === 'radio') && !f.checked) return;
        fd.append(f.name, f.value);
        data[f.name] = f.value;            // нужен транспортам без FormData (Тильда)
      });
      each(chosen, function (file, i) { fd.append('file' + (i + 1), file, file.name); });

      busy = true;
      if (button) { button.disabled = true; button.textContent = 'Отправляем…'; }
      setStatus('Отправляем заявку…', 'info');

      send(fd, data, 0);
    }, false);

    function send(fd, data, attempt) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint, true);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.timeout = 120000;

      if (xhr.upload && chosen.length) {
        xhr.upload.onprogress = function (ev) {
          if (!ev.lengthComputable) return;
          var pct = Math.round(ev.loaded / ev.total * 100);
          setStatus(pct < 100 ? 'Загружаем файлы… ' + pct + '%' : 'Отправляем заявку…', 'info');
        };
      }

      function fail(text) {
        busy = false;
        if (button) { button.disabled = false; button.innerHTML = buttonHtml; }
        setStatus(text, 'error');
      }

      xhr.onload = function () {
        var json = null;
        try { json = JSON.parse(xhr.responseText); } catch (err) { /* сервер вернул не JSON */ }

        if (xhr.status >= 200 && xhr.status < 300 && json && json.ok) {
          busy = false;
          if (window.dataLayer && window.dataLayer.push) {
            window.dataLayer.push({ event: 'form_success', form_page: pageName });
          }
          if (window.ym && window.M88_YM_ID) window.ym(window.M88_YM_ID, 'reachGoal', 'form_success');
          showSuccess(json.ticket, json.skipped);
          return;
        }

        // Форма заполнена быстрее, чем ждёт антиспам (автозаполнение) —
        // повторяем отправку сами, пользователь ничего не делает.
        if (json && json.retry_after && attempt < 1) {
          setStatus('Отправляем заявку…', 'info');
          setTimeout(function () { send(fd, data, attempt + 1); }, (json.retry_after * 1000) + 200);
          return;
        }

        if (xhr.status === 413) {
          return fail('Файлы слишком большие для сервера. Уменьшите вложения или '
            + 'пришлите ссылку на облако.');
        }
        fail((json && json.message) ||
          'Не удалось отправить. Позвоните: +7 (499) 325-69-82 или напишите на zakaz@m88.su.');
        if (json && json.field) {
          var bad = form.querySelector('[name="' + json.field + '"]');
          if (bad && bad.focus) bad.focus();
        }
      };
      xhr.onerror = function () {
        fail('Нет связи с сервером. Проверьте интернет или напишите на zakaz@m88.su.');
      };
      xhr.ontimeout = function () {
        fail('Сервер долго не отвечает. Попробуйте ещё раз или напишите на zakaz@m88.su.');
      };

      xhr.send(fd);
    }
  }

  function boot() {
    each(document.querySelectorAll('form[data-m88form]'), init);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }
})();
