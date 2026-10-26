const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const template = readFileSync(resolve(
    __dirname,
    "../integreat_chat/bescheidcheck/templates/bescheidcheck/bescheidcheck.html",
), "utf8");
const script = template.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
    .replace("{{ max_images }}", "10")
    .replace("{{ supported_languages_js|safe }}", '["de", "en"]');
new vm.Script(script); // Check the complete inline script, including the IIFE.
const start = script.indexOf("    function parseSSEFrame(");
const end = script.indexOf("    function reconcileTranslationMarks(");
assert.ok(start >= 0 && end > start);
const progressCode = script.slice(start, end);
const handlerStart = script.indexOf('if (msg.event === "stage" && msg.data)');
const handlerEnd = script.indexOf('} else if (msg.event === "pages")', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
const stageHandler = script.slice(handlerStart, handlerEnd + 1);
const progressMarkup = template.match(/id="progressBar"[\s\S]*?hidden>/)[0];
const ariaMax = progressMarkup.match(/aria-valuemax="([^"]+)"/)[1];

function element() {
    const attributes = new Map();
    const classes = new Set();
    return {
        hidden: true,
        textContent: "",
        style: { width: "0%", display: "none" },
        classList: {
            toggle(name, enabled) {
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
        },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name); },
    };
}

function setup() {
    const els = {
        progress: element(),
        progressBar: element(),
        progressBarFill: element(),
        progressBarLabel: element(),
    };
    els.progressBar.setAttribute("aria-valuemax", ariaMax);
    const context = vm.createContext({
        els, started: 0, elapsed: 0, performance: { now: () => 1000 },
    });
    vm.runInContext(progressCode + `
        globalThis.api = {
            parseSSEFrame, resetProgressUI, resetTranslationProgress,
            updateTranslateTicker, translationProgress,
        };
    `, context);
    function stage(data) {
        context.msg = context.api.parseSSEFrame(
            `event: stage\ndata: ${JSON.stringify(data)}\n\n`,
        );
        vm.runInContext(stageHandler, context);
    }
    return { els, api: context.api, stage };
}

for (const total of [3, 4, 5]) {
    test(`all stages in a ${total}-stage pipeline have matching counts and percentages`, () => {
        const { els, stage } = setup();
        const names = ["ocr", "translate", "classify", "extraction", "counseling"];
        let previous = 0;
        for (let index = 1; index <= total; index++) {
            for (const status of ["started", "done"]) {
                stage({ stage: names[index - 1], index, total, status, seconds: 0.1 });
                const completed = status === "done" ? index : index - 1;
                const expected = completed / total * 100;
                const width = parseFloat(els.progressBarFill.style.width);
                assert.ok(Math.abs(width - expected) < 1e-8);
                assert.ok(width >= previous && width <= 100);
                previous = width;
                assert.equal(els.progressBar.getAttribute("aria-valuenow"), String(Math.round(expected)));
                assert.equal(els.progressBar.classList.contains("indeterminate"), status === "started");
                if (status === "started") {
                    assert.ok(els.progressBarLabel.textContent.includes(`stage ${index}/${total}`));
                    if (names[index - 1] === "extraction") {
                        assert.match(els.progressBarLabel.textContent, /^Extracting data/);
                    }
                }
            }
        }
        assert.equal(els.progressBarFill.style.width, "100%");
        assert.equal(els.progressBar.getAttribute("aria-valuenow"), els.progressBar.getAttribute("aria-valuemax"));
    });
}

test("translation paragraph updates retain the backend stage counter", () => {
    const { els, api, stage } = setup();
    stage({ stage: "translate", index: 2, total: 4, status: "started" });
    api.translationProgress.total = 3;
    api.translationProgress.done = 2;
    api.updateTranslateTicker();
    assert.equal(els.progressBarLabel.textContent, "Translating… · stage 2/4 · 2 of 3 paragraph(s)");
});

test("reset clears the counter and accessible value before another analysis", () => {
    const { els, api, stage } = setup();
    stage({ stage: "extraction", index: 4, total: 4, status: "done" });
    api.resetProgressUI();
    api.resetTranslationProgress();
    assert.equal(els.progressBarFill.style.width, "0%");
    assert.equal(els.progressBar.getAttribute("aria-valuenow"), "0");
    assert.equal(els.progressBar.hidden, true);
    assert.equal(els.progressBarLabel.hidden, true);
    api.translationProgress.total = 1;
    api.updateTranslateTicker();
    assert.equal(els.progressBarLabel.textContent, "Translating… · 0 of 1 paragraph(s)");
    stage({ stage: "ocr", index: 1, total: 5, status: "started" });
    assert.equal(els.progressBarLabel.textContent, "Reading & OCR… · stage 1/5");
});

for (const total of [undefined, 4]) {
    test(`stage 5 does not claim an invalid total (${total})`, () => {
        const { els, stage } = setup();
        stage({ stage: "counseling", index: 5, total, status: "started" });
        assert.equal(els.progressBarLabel.textContent, "Finding a counseling option… · stage 5");
        assert.equal(els.progressBar.getAttribute("aria-valuenow"), undefined);
        assert.equal(els.progressBar.classList.contains("indeterminate"), true);
        assert.equal(els.progressBarFill.style.width, "0%");
    });
}
