"use strict";

const LOCAL_STORAGE_KEY = "quizzes-store";
const KEEPALIVE_REQUEST_LIMIT = 60000;
/* Provided only by the desktop app's local server. The website uses browser storage. */
const localDatabase = window.__QUIZZES_LOCAL_DATABASE__ || null;
const DEFAULT_SETTINGS = { shuffleQuestions: false, shuffleAnswers: false, showExplanations: true, showTimer: true };
const TIMER_DISPLAY_INTERVAL_MILLISECONDS = 500;
const TIMER_SAVE_INTERVAL_MILLISECONDS = 5000;

const EXAMPLE_QUIZ_JSON = `{
  "title": "Python Basics",
  "questions": [
    {
      "question": "What indentation does PEP 8 recommend for a \`def\` body?",
      "options": ["One tab", "Eight spaces", "Four spaces", "Two spaces"],
      "answer": "C",
      "explanation": "PEP 8 recommends 4 spaces per indentation level."
    },
    {
      "question": "What does \`len([1, 2, 3])\` return?",
      "options": ["2", "3", "4", "An error"],
      "answer": 1,
      "explanation": "The list has three items. A number answer counts from 0."
    },
    {
      "question": "Which keyword starts a loop over a list?",
      "options": ["for", "def", "class", "import"],
      "answer": "for"
    }
  ]
}`;

const ICON_PATHS = {
  home: '<path d="M4 6.5h16M4 12h16M4 17.5h10"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/>',
  restart: '<path d="M5 12a7 7 0 1 0 2.2-5.1L5 9M5 4.5V9h4.5"/>',
  instructions: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
};

const DEFAULT_TEMPLATE_QUESTION_COUNT = 20;
const MAXIMUM_TEMPLATE_QUESTION_COUNT = 200;
const KEYBOARD_SHORTCUTS = [
  { action: "Choose an answer", keys: ["A–Z", "1–9"] },
  { action: "Continue", keys: ["Return"] },
  { action: "Previous question", keys: ["←"] },
  { action: "Pause or resume the timer", keys: ["P"] },
  { action: "Leave the quiz", keys: ["Esc"] },
];

function createTemplatePrompt(questionCount) {
  return `Create a multiple choice quiz from the content I attached or included with this message.

Requirements:
- Write exactly ${questionCount} questions, or as many as the content can genuinely support if it is too short.
- Use only information from the content. Do not add outside facts.
- Always start with breadth: the first questions must cover the main topics across all of the content, so every major topic appears before any topic is revisited.
- Then go further in depth: use the remaining questions to probe details, connections between ideas, edge cases, and reasoning within those topics.
- Write the kinds of questions a professor is likely to ask on an exam on this material, focusing on what the content emphasizes and what is most testable.
- Word each question the way a professor would on a real exam: precise, academic, and demanding careful reading. Do not simplify the wording or make a question easier just to keep it short. Use scenarios, qualifiers such as "most likely" or "best explains", and multi-step reasoning where they fit.
- Test understanding and application, not only memorization.
- Give each question 4 answer options with exactly one correct answer.
- Make the wrong options believable, and keep all options similar in length and style.
- Spread the correct answers evenly across A, B, C, and D.
- Do not use "all of the above" or "none of the above".
- Add a short explanation of why the correct answer is right.
- Put code, commands, and formulas in single backticks.

Output format:
- Return only valid JSON in one code block, with no other text before or after it.
- Do not put letters such as "A." in front of the options.
- Set "answer" to the letter of the correct option: "A", "B", "C", or "D".
- Escape any double quotes inside text.

Use exactly this structure:

{
  "title": "Short quiz title",
  "questions": [
    {
      "question": "Question text",
      "options": ["First option", "Second option", "Third option", "Fourth option"],
      "answer": "B",
      "explanation": "Why the correct answer is right."
    }
  ]
}`;
}

const NAVIGATION_ITEMS = [
  { view: "home", label: "Home", icon: "home" },
  { view: "create", label: "Create", icon: "create" },
  { view: "instructions", label: "Instructions", icon: "instructions" },
];

const store = loadStore();
const applicationState = {
  view: "home",
  quizId: null,
  finishedAttempt: null,
  animateQuestion: false,
  pendingDeleteQuizId: null,
  isConfirmingDeleteAll: false,
  createDraft: { title: "", jsonText: "", fileTitle: "" },
  templateQuestionCount: String(DEFAULT_TEMPLATE_QUESTION_COUNT),
};

const sidebarElement = document.getElementById("sidebar");
const mainContentElement = document.getElementById("main-content");
const toastElement = document.getElementById("toast");
let toastTimer = null;
let runningQuizTimer = null;
let lastTimerSaveAt = 0;
let pendingDatabaseStore = null;
let isDatabaseSaveRunning = false;

/* Storage */

function loadStore() {
  let savedStore = localDatabase?.store || null;
  if (!localDatabase) {
    try {
      savedStore = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY));
    } catch (storageError) {
      savedStore = null;
    }
  }
  return {
    quizzes: Array.isArray(savedStore?.quizzes) ? savedStore.quizzes : [],
    settings: { ...DEFAULT_SETTINGS, ...(savedStore?.settings || {}) },
  };
}

async function sendPendingDatabaseSaves() {
  if (isDatabaseSaveRunning) return;
  isDatabaseSaveRunning = true;
  while (pendingDatabaseStore !== null) {
    const serializedStore = pendingDatabaseStore;
    pendingDatabaseStore = null;
    try {
      const response = await fetch("/api/store", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Quizzes-Token": localDatabase.token },
        body: serializedStore,
        keepalive: serializedStore.length < KEEPALIVE_REQUEST_LIMIT,
      });
      if (!response.ok) throw new Error("The database rejected the save.");
    } catch (saveError) {
      pendingDatabaseStore = pendingDatabaseStore ?? serializedStore;
      showToast("Could not save your changes.");
      break;
    }
  }
  isDatabaseSaveRunning = false;
}

function saveStore() {
  if (localDatabase) {
    pendingDatabaseStore = JSON.stringify(store);
    sendPendingDatabaseSaves();
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(store));
  } catch (storageError) {
    showToast("Could not save your changes.");
  }
}

function showToast(message) {
  toastElement.textContent = message;
  toastElement.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 3200);
}

/* Small DOM helpers. Quiz text is always inserted as text, never as HTML. */

function createElement(tagName, properties = {}, ...children) {
  const element = document.createElement(tagName);
  for (const [propertyName, propertyValue] of Object.entries(properties)) {
    if (propertyValue === null || propertyValue === undefined || propertyValue === false) continue;
    if (propertyName.startsWith("on")) {
      element.addEventListener(propertyName.slice(2).toLowerCase(), propertyValue);
    } else if (propertyName === "className") {
      element.className = propertyValue;
    } else if (propertyName === "value") {
      element.value = propertyValue;
    } else {
      element.setAttribute(propertyName, propertyValue === true ? "" : propertyValue);
    }
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

function createIcon(iconName) {
  const iconElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  iconElement.setAttribute("class", "icon");
  iconElement.setAttribute("viewBox", "0 0 24 24");
  iconElement.setAttribute("fill", "none");
  iconElement.setAttribute("stroke", "currentColor");
  iconElement.setAttribute("stroke-width", "2");
  iconElement.setAttribute("stroke-linecap", "round");
  iconElement.setAttribute("stroke-linejoin", "round");
  iconElement.setAttribute("aria-hidden", "true");
  iconElement.innerHTML = ICON_PATHS[iconName];
  return iconElement;
}

/* Renders `inline code` and ```code blocks``` inside quiz text. */
function createRichText(text) {
  return text.split(/(```[\s\S]*?```|`[^`\n]+`)/g).filter(Boolean).map((textPart) => {
    if (textPart.startsWith("```") && textPart.endsWith("```") && textPart.length >= 6) {
      const codeText = textPart.slice(3, -3).replace(/^[a-zA-Z]*\n/, "").replace(/\n$/, "");
      return createElement("pre", {}, codeText);
    }
    if (textPart.startsWith("`") && textPart.endsWith("`") && textPart.length > 2) {
      return createElement("code", {}, textPart.slice(1, -1));
    }
    return textPart;
  });
}

function optionLabel(optionPosition) {
  return optionPosition < 26 ? String.fromCharCode(65 + optionPosition) : String(optionPosition + 1);
}

function pluralize(count, singularWord) {
  return `${count} ${singularWord}${count === 1 ? "" : "s"}`;
}

function shuffledIndexes(itemCount, shouldShuffle) {
  const indexes = Array.from({ length: itemCount }, (_, index) => index);
  if (!shouldShuffle) return indexes;
  for (let currentIndex = indexes.length - 1; currentIndex > 0; currentIndex -= 1) {
    const swapIndex = Math.floor(Math.random() * (currentIndex + 1));
    [indexes[currentIndex], indexes[swapIndex]] = [indexes[swapIndex], indexes[currentIndex]];
  }
  return indexes;
}

/* Quiz logic */

function findQuiz(quizId) {
  return store.quizzes.find((quiz) => quiz.id === quizId) || null;
}

function currentQuiz() {
  return findQuiz(applicationState.quizId);
}

function createAttempt(quiz) {
  const steps = shuffledIndexes(quiz.questions.length, store.settings.shuffleQuestions).map((questionIndex) => ({
    questionIndex,
    optionOrder: shuffledIndexes(quiz.questions[questionIndex].options.length, store.settings.shuffleAnswers),
    selectedOption: null,
  }));
  return { steps, position: 0, elapsedMilliseconds: 0, isTimerPaused: false };
}

function calculateScore(quiz, attempt) {
  let correctCount = 0;
  let wrongCount = 0;
  for (const step of attempt.steps) {
    if (step.selectedOption === null) continue;
    if (step.selectedOption === quiz.questions[step.questionIndex].correctIndex) correctCount += 1;
    else wrongCount += 1;
  }
  return { correctCount, wrongCount };
}

/* Quiz timer. It only counts while the quiz is on screen and not paused. */

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function elapsedQuizTime(attempt) {
  const savedMilliseconds = attempt.elapsedMilliseconds || 0;
  if (runningQuizTimer?.attempt !== attempt) return savedMilliseconds;
  return savedMilliseconds + Date.now() - runningQuizTimer.startedAt;
}

function isQuizPaused(attempt) {
  return store.settings.showTimer && Boolean(attempt.isTimerPaused);
}

function recordRunningQuizTime() {
  if (!runningQuizTimer) return;
  const currentTime = Date.now();
  const { attempt, startedAt } = runningQuizTimer;
  attempt.elapsedMilliseconds = (attempt.elapsedMilliseconds || 0) + currentTime - startedAt;
  runningQuizTimer.startedAt = currentTime;
  lastTimerSaveAt = currentTime;
  saveStore();
}

function stopQuizTimer() {
  recordRunningQuizTime();
  runningQuizTimer = null;
}

function synchronizeQuizTimer() {
  const attempt = applicationState.view === "quiz" ? currentQuiz()?.activeAttempt : null;
  const shouldRun = Boolean(attempt) && store.settings.showTimer && !attempt.isTimerPaused
    && document.visibilityState === "visible";
  if (runningQuizTimer && (!shouldRun || runningQuizTimer.attempt !== attempt)) stopQuizTimer();
  if (shouldRun && !runningQuizTimer) {
    runningQuizTimer = { attempt, startedAt: Date.now() };
    lastTimerSaveAt = Date.now();
  }
}

function updateQuizTimerDisplay() {
  const timerElement = document.getElementById("quiz-timer");
  const attempt = currentQuiz()?.activeAttempt;
  if (timerElement && attempt) timerElement.textContent = formatDuration(elapsedQuizTime(attempt));
}

function toggleQuizTimer() {
  const attempt = currentQuiz()?.activeAttempt;
  if (!attempt || !store.settings.showTimer) return;
  stopQuizTimer();
  attempt.isTimerPaused = !attempt.isTimerPaused;
  saveStore();
  render();
}

function navigate(view) {
  applicationState.view = view;
  applicationState.pendingDeleteQuizId = null;
  applicationState.isConfirmingDeleteAll = false;
  render();
}

function openQuiz(quizId, shouldRestart = false) {
  const quiz = findQuiz(quizId);
  if (!quiz) return;
  if (shouldRestart || !quiz.activeAttempt) {
    quiz.activeAttempt = createAttempt(quiz);
    saveStore();
  }
  applicationState.quizId = quizId;
  applicationState.animateQuestion = true;
  navigate("quiz");
}

function selectAnswer(optionIndex) {
  const attempt = currentQuiz()?.activeAttempt;
  if (!attempt || isQuizPaused(attempt)) return;
  const step = attempt.steps[attempt.position];
  if (step.selectedOption !== null) return;
  step.selectedOption = optionIndex;
  saveStore();
  render();
}

function goToPreviousQuestion() {
  const attempt = currentQuiz()?.activeAttempt;
  if (!attempt || attempt.position === 0 || isQuizPaused(attempt)) return;
  attempt.position -= 1;
  applicationState.animateQuestion = true;
  saveStore();
  render();
}

function continueQuiz() {
  const quiz = currentQuiz();
  const attempt = quiz?.activeAttempt;
  if (!attempt || isQuizPaused(attempt) || attempt.steps[attempt.position].selectedOption === null) return;
  if (attempt.position < attempt.steps.length - 1) {
    attempt.position += 1;
    applicationState.animateQuestion = true;
    saveStore();
    render();
    return;
  }
  stopQuizTimer();
  const { correctCount, wrongCount } = calculateScore(quiz, attempt);
  quiz.lastResult = {
    correctCount,
    wrongCount,
    totalCount: attempt.steps.length,
    finishedAt: Date.now(),
    elapsedMilliseconds: store.settings.showTimer ? attempt.elapsedMilliseconds || 0 : null,
  };
  quiz.activeAttempt = null;
  applicationState.finishedAttempt = attempt;
  saveStore();
  navigate("results");
}

function deleteQuiz(quizId) {
  store.quizzes = store.quizzes.filter((quiz) => quiz.id !== quizId);
  applicationState.pendingDeleteQuizId = null;
  saveStore();
  render();
}

/* Sidebar */

function renderSidebar() {
  const activeView = ["quiz", "results"].includes(applicationState.view) ? "home" : applicationState.view;
  const createNavigationButton = ({ view, label, icon }) => createElement("button", {
    className: "sidebar-button",
    type: "button",
    "aria-current": activeView === view ? "page" : null,
    onClick: () => navigate(view),
  }, createIcon(icon), label);

  sidebarElement.replaceChildren(
    ...NAVIGATION_ITEMS.map(createNavigationButton),
    createElement("div", { className: "sidebar-spacer" }),
    createNavigationButton({ view: "settings", label: "Settings", icon: "settings" }),
  );
}

/* Home page */

function describeQuiz(quiz) {
  const questionText = pluralize(quiz.questions.length, "question");
  if (quiz.activeAttempt) {
    const answeredCount = quiz.activeAttempt.steps.filter((step) => step.selectedOption !== null).length;
    return `${questionText} · In progress, ${answeredCount} answered`;
  }
  if (quiz.lastResult) {
    const { correctCount, totalCount, elapsedMilliseconds } = quiz.lastResult;
    const scoreText = `${questionText} · Last score ${correctCount}/${totalCount} (${Math.round((correctCount / totalCount) * 100)}%)`;
    return Number.isFinite(elapsedMilliseconds) ? `${scoreText} · ${formatDuration(elapsedMilliseconds)}` : scoreText;
  }
  return questionText;
}

function createQuizRow(quiz) {
  const isConfirmingDelete = applicationState.pendingDeleteQuizId === quiz.id;
  const setPendingDelete = (quizId) => {
    applicationState.pendingDeleteQuizId = quizId;
    render();
  };

  const actions = isConfirmingDelete
    ? [
        createElement("button", { className: "button button-small button-secondary", type: "button", onClick: () => setPendingDelete(null) }, "Cancel"),
        createElement("button", { className: "button button-small button-danger", type: "button", onClick: () => deleteQuiz(quiz.id) }, "Delete"),
      ]
    : [
        quiz.activeAttempt && createElement("button", {
          className: "icon-button", type: "button", title: "Start over", "aria-label": `Start ${quiz.title} over`,
          onClick: () => openQuiz(quiz.id, true),
        }, createIcon("restart")),
        createElement("button", {
          className: "icon-button", type: "button", title: "Delete quiz", "aria-label": `Delete ${quiz.title}`,
          onClick: () => setPendingDelete(quiz.id),
        }, createIcon("trash")),
        createElement("button", {
          className: "button button-small button-secondary", type: "button", onClick: () => openQuiz(quiz.id),
        }, quiz.activeAttempt ? "Resume" : "Start"),
      ];

  return createElement("div", { className: "quiz-row" },
    createElement("button", { className: "quiz-row-open", type: "button", onClick: () => openQuiz(quiz.id) },
      createElement("span", { className: "quiz-row-title" }, quiz.title),
      createElement("span", { className: "quiz-row-details" }, describeQuiz(quiz))),
    createElement("div", { className: "quiz-row-actions" }, actions));
}

function renderHomePage() {
  const newQuizButton = createElement("button", {
    className: "button button-primary", type: "button", onClick: () => navigate("create"),
  }, createIcon("create"), "New quiz");

  const content = store.quizzes.length > 0
    ? createElement("div", { className: "quiz-list" }, store.quizzes.map(createQuizRow))
    : createElement("div", { className: "empty-state" },
        createElement("p", { className: "empty-state-title" }, "No quizzes yet"),
        createElement("p", { className: "empty-state-text" }, "Paste multiple choice questions as JSON, or upload a JSON file."),
        newQuizButton);

  return createElement("div", { className: "page" },
    createElement("div", { className: "page-inner" },
      createElement("header", { className: "page-header" },
        createElement("div", {},
          createElement("h1", { className: "page-title" }, "Quiz Maker"),
          store.quizzes.length > 0 && createElement("p", { className: "page-subtitle" }, pluralize(store.quizzes.length, "quiz").replace("quizs", "quizzes"))),
        store.quizzes.length > 0 && newQuizButton),
      content));
}

/* Create page */

function renderCreatePage() {
  const draft = applicationState.createDraft;
  const validationElement = createElement("div", { className: "validation-message", "aria-live": "polite" });
  const createButton = createElement("button", { className: "button button-primary", type: "button", disabled: true, onClick: saveDraftAsQuiz }, "Create quiz");
  const titleInput = createElement("input", {
    className: "text-input", id: "quiz-title-input", type: "text", maxlength: "120", autocomplete: "off",
    placeholder: "Untitled quiz", value: draft.title,
    onInput: (event) => { draft.title = event.target.value; },
  });
  const jsonInput = createElement("textarea", {
    className: "json-input", id: "quiz-json-input", spellcheck: "false", autocapitalize: "off", autocomplete: "off",
    placeholder: '{ "title": "My quiz", "questions": [ ... ] }', value: draft.jsonText,
    onInput: (event) => { draft.jsonText = event.target.value; updateValidation(); },
    onDragover: (event) => { event.preventDefault(); jsonInput.classList.add("is-dragging"); },
    onDragleave: () => jsonInput.classList.remove("is-dragging"),
    onDrop: (event) => {
      event.preventDefault();
      event.stopPropagation();
      jsonInput.classList.remove("is-dragging");
      if (event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]);
    },
  });
  const fileInput = createElement("input", {
    type: "file", accept: ".json,application/json", hidden: true,
    onChange: (event) => { if (event.target.files[0]) loadFile(event.target.files[0]); event.target.value = ""; },
  });

  function parsedDraft() {
    return QuizParser.parse(draft.jsonText);
  }

  function updateValidation() {
    const parseResult = parsedDraft();
    createButton.disabled = !parseResult.isValid;
    titleInput.placeholder = parseResult.title || draft.fileTitle || "Untitled quiz";
    validationElement.className = "validation-message";
    if (parseResult.isEmpty) {
      validationElement.replaceChildren();
    } else if (parseResult.isValid) {
      validationElement.classList.add("is-valid");
      validationElement.replaceChildren(`${pluralize(parseResult.questions.length, "question")} ready`);
    } else {
      validationElement.classList.add("is-invalid");
      const visibleProblems = parseResult.problems.slice(0, 4).map((problem) => createElement("li", {}, problem));
      const hiddenProblemCount = parseResult.problems.length - visibleProblems.length;
      if (hiddenProblemCount > 0) visibleProblems.push(createElement("li", {}, `${hiddenProblemCount} more`));
      validationElement.replaceChildren(createElement("ul", {}, visibleProblems));
    }
  }

  async function loadFile(file) {
    try {
      draft.jsonText = await file.text();
    } catch (readError) {
      showToast("Could not read that file.");
      return;
    }
    draft.fileTitle = file.name.replace(/\.[^.]+$/, "");
    jsonInput.value = draft.jsonText;
    updateValidation();
  }

  function saveDraftAsQuiz() {
    const parseResult = parsedDraft();
    if (!parseResult.isValid) return;
    store.quizzes.unshift({
      id: `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: draft.title.trim() || parseResult.title || draft.fileTitle || "Untitled quiz",
      questions: parseResult.questions,
      createdAt: Date.now(),
      activeAttempt: null,
      lastResult: null,
    });
    applicationState.createDraft = { title: "", jsonText: "", fileTitle: "" };
    saveStore();
    navigate("home");
  }

  updateValidation();

  return createElement("div", { className: "page" },
    createElement("div", { className: "page-inner" },
      createElement("header", { className: "page-header" },
        createElement("div", {},
          createElement("h1", { className: "page-title" }, "Create quiz"),
          createElement("p", { className: "page-subtitle" }, "Paste JSON below, or upload a file."))),
      createElement("div", { className: "form-stack" },
        createElement("div", {},
          createElement("label", { className: "field-label", for: "quiz-title-input" }, "Title"),
          titleInput),
        createElement("div", {},
          createElement("div", { className: "field-label-row" },
            createElement("label", { className: "field-label", for: "quiz-json-input" }, "Quiz JSON"),
            createElement("button", {
              className: "text-button", type: "button",
              onClick: () => { draft.jsonText = EXAMPLE_QUIZ_JSON; jsonInput.value = EXAMPLE_QUIZ_JSON; updateValidation(); },
            }, "Use example")),
          jsonInput),
        validationElement,
        createElement("div", { className: "create-actions" },
          fileInput,
          createElement("button", { className: "button button-secondary", type: "button", onClick: () => fileInput.click() }, createIcon("upload"), "Upload JSON"),
          createButton),
        createElement("details", { className: "format-help" },
          createElement("summary", {}, "Accepted format"),
          createElement("p", {}, "Each question needs text, at least two options, and one correct answer. The answer can be a letter, the option text, or a number counted from 0. An explanation is optional."),
          createElement("pre", {}, '[\n  {\n    "question": "What is 2 + 2?",\n    "options": ["3", "4", "5"],\n    "answer": "B",\n    "explanation": "2 + 2 equals 4."\n  }\n]')))));
}

/* Instructions page */

function validTemplateQuestionCount() {
  const questionCount = Number.parseInt(applicationState.templateQuestionCount, 10);
  if (!Number.isFinite(questionCount) || questionCount < 1) return DEFAULT_TEMPLATE_QUESTION_COUNT;
  return Math.min(questionCount, MAXIMUM_TEMPLATE_QUESTION_COUNT);
}

async function copyTextToClipboard(text, fallbackTextArea) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (clipboardError) {
    fallbackTextArea.focus();
    fallbackTextArea.select();
    return document.execCommand("copy");
  }
}

function createInstructionStep(stepNumber, title, description, ...stepContent) {
  return createElement("li", { className: "instruction-step" },
    createElement("span", { className: "instruction-step-number", "aria-hidden": "true" }, String(stepNumber)),
    createElement("div", { className: "instruction-step-body" },
      createElement("h2", { className: "instruction-step-title" }, title),
      createElement("p", { className: "instruction-step-description" }, description),
      stepContent));
}

function createKeyboardShortcutTable() {
  const createKeyCell = (keyNames) => createElement("td", {},
    keyNames.flatMap((keyName, keyIndex) => [
      keyIndex > 0 && " or ",
      createElement("kbd", {}, keyName),
    ]));

  return createElement("section", { className: "keyboard-settings instruction-shortcuts" },
    createElement("h2", { className: "section-title" }, "Keyboard shortcuts"),
    createElement("table", { className: "shortcut-table" },
      createElement("thead", {},
        createElement("tr", {},
          createElement("th", { scope: "col" }, "Key"),
          createElement("th", { scope: "col" }, "Action"))),
      createElement("tbody", {},
        KEYBOARD_SHORTCUTS.map(({ action, keys }) => createElement("tr", {},
          createKeyCell(keys),
          createElement("td", {}, action))))));
}

function renderInstructionsPage() {
  let copiedLabelTimer = null;
  const promptInput = createElement("textarea", {
    className: "json-input template-prompt", id: "template-prompt", readonly: true, spellcheck: "false",
    value: createTemplatePrompt(validTemplateQuestionCount()),
  });
  const copyButtonLabel = createElement("span", {}, "Copy prompt");
  const copyButton = createElement("button", {
    className: "button button-primary", type: "button",
    onClick: async () => {
      const wasCopied = await copyTextToClipboard(promptInput.value, promptInput);
      if (!wasCopied) {
        showToast("Could not copy. Select the prompt and press ⌘C.");
        return;
      }
      copyButtonLabel.textContent = "Copied";
      clearTimeout(copiedLabelTimer);
      copiedLabelTimer = setTimeout(() => { copyButtonLabel.textContent = "Copy prompt"; }, 1800);
    },
  }, createIcon("copy"), copyButtonLabel);
  const questionCountInput = createElement("input", {
    className: "text-input question-count-input", id: "template-question-count", type: "number",
    min: "1", max: String(MAXIMUM_TEMPLATE_QUESTION_COUNT), value: applicationState.templateQuestionCount,
    onInput: (event) => {
      applicationState.templateQuestionCount = event.target.value;
      promptInput.value = createTemplatePrompt(validTemplateQuestionCount());
    },
  });

  return createElement("div", { className: "page" },
    createElement("div", { className: "page-inner" },
      createElement("header", { className: "page-header" },
        createElement("div", {},
          createElement("h1", { className: "page-title" }, "Instructions"),
          createElement("p", { className: "page-subtitle" }, "Turn your course material into a quiz with any AI chat."))),
      createElement("ol", { className: "instruction-list" },
        createInstructionStep(1, "Copy the prompt", "Choose how many questions you want, then copy this prompt.",
          createElement("div", { className: "template-controls" },
            createElement("div", {},
              createElement("label", { className: "field-label", for: "template-question-count" }, "Questions"),
              questionCountInput),
            copyButton),
          createElement("label", { className: "field-label prompt-label", for: "template-prompt" }, "AI prompt"),
          promptInput),
        createInstructionStep(2, "Give it to your AI with your content", "Open your AI chat, paste the prompt, and attach or paste your notes, slides, or readings. Then send it."),
        createInstructionStep(3, "Copy the JSON it returns", "Use the copy button on the AI's code block so you get all of the JSON."),
        createInstructionStep(4, "Create the quiz", "Paste the JSON into Create. When you see that your questions are ready, click Create quiz.",
          createElement("button", { className: "button button-secondary instruction-step-action", type: "button", onClick: () => navigate("create") }, "Go to Create")),
        createInstructionStep(5, "Take the quiz", "Open it from Home and click Start. Choose an answer to see if you were right, then click Continue. Your score appears at the end.")),
      createKeyboardShortcutTable()));
}

/* Settings page */

function createToggleRow(settingName, title, description) {
  return createElement("div", { className: "settings-row" },
    createElement("div", {},
      title,
      createElement("span", { className: "settings-row-description" }, description)),
    createElement("button", {
      className: "toggle", type: "button", role: "switch", "aria-label": title,
      "aria-checked": String(store.settings[settingName]),
      onClick: () => {
        store.settings[settingName] = !store.settings[settingName];
        saveStore();
        render();
      },
    }));
}

function createShortcutRow(description, ...keyNames) {
  return createElement("div", { className: "settings-row" },
    description,
    createElement("div", { className: "confirm-actions" }, keyNames.map((keyName) => createElement("kbd", {}, keyName))));
}

function renderSettingsPage() {
  const setConfirmDeleteAll = (isConfirming) => {
    applicationState.isConfirmingDeleteAll = isConfirming;
    render();
  };
  const deleteAllControl = applicationState.isConfirmingDeleteAll
    ? createElement("div", { className: "confirm-actions" },
        createElement("button", { className: "button button-small button-secondary", type: "button", onClick: () => setConfirmDeleteAll(false) }, "Cancel"),
        createElement("button", {
          className: "button button-small button-danger", type: "button",
          onClick: () => {
            store.quizzes = [];
            applicationState.isConfirmingDeleteAll = false;
            saveStore();
            render();
          },
        }, "Delete all"))
    : createElement("button", {
        className: "button button-small button-secondary", type: "button",
        disabled: store.quizzes.length === 0, onClick: () => setConfirmDeleteAll(true),
      }, "Delete all");

  return createElement("div", { className: "page" },
    createElement("div", { className: "page-inner" },
      createElement("header", { className: "page-header" }, createElement("h1", { className: "page-title" }, "Settings")),
      createElement("h2", { className: "settings-group-title" }, "Quiz"),
      createElement("section", { className: "settings-group" },
        createToggleRow("shuffleQuestions", "Shuffle questions", "Use a new order each time you start a quiz."),
        createToggleRow("shuffleAnswers", "Shuffle answers", "Mix up the answer options in each question."),
        createToggleRow("showExplanations", "Show explanations", "Show the reason after you answer, when the quiz has one."),
        createToggleRow("showTimer", "Quiz timer", "Start a timer with each quiz. You can pause and resume it.")),
      createElement("div", { className: "keyboard-settings" },
        createElement("h2", { className: "settings-group-title" }, "Keyboard"),
        createElement("section", { className: "settings-group" },
          KEYBOARD_SHORTCUTS.map(({ action, keys }) => createShortcutRow(action, ...keys)))),
      createElement("h2", { className: "settings-group-title" }, "Data"),
      createElement("section", { className: "settings-group" },
        localDatabase && createElement("div", { className: "settings-row" },
          createElement("div", {},
            "Saved on this Mac",
            createElement("span", { className: "settings-row-description" }, "Quizzes and scores are kept in a local database, separate from browser data."))),
        createElement("div", { className: "settings-row" },
          createElement("div", {},
            "Delete all quizzes",
            createElement("span", { className: "settings-row-description" }, "This removes every quiz and score and cannot be undone.")),
          deleteAllControl))));
}

/* Quiz screen */

function createScorePills(correctCount, wrongCount) {
  return [
    createElement("span", { className: "score-pill score-pill-wrong", "aria-label": `${wrongCount} wrong` }, createIcon("close"), String(wrongCount)),
    createElement("span", { className: "score-pill score-pill-correct", "aria-label": `${correctCount} correct` }, createIcon("check"), String(correctCount)),
  ];
}

function createAnswerOption(question, step, optionIndex, optionPosition) {
  const hasAnswered = step.selectedOption !== null;
  const isCorrectOption = optionIndex === question.correctIndex;
  const isSelectedOption = optionIndex === step.selectedOption;
  const stateClasses = [];
  let badge = null;
  let explanationText = "";

  if (hasAnswered) {
    if (isCorrectOption) {
      stateClasses.push("is-correct");
      badge = createElement("span", { className: "answer-badge" }, createIcon("check"), "Correct answer");
      explanationText = question.optionExplanations[optionIndex] || question.explanation;
    } else if (isSelectedOption) {
      stateClasses.push("is-wrong");
      badge = createElement("span", { className: "answer-badge" }, createIcon("close"), "Not quite");
      explanationText = question.optionExplanations[optionIndex];
    } else {
      stateClasses.push("is-dimmed");
    }
  }

  return createElement("button", {
    className: ["answer-option", ...stateClasses].join(" "),
    type: "button",
    disabled: hasAnswered,
    onClick: () => selectAnswer(optionIndex),
  },
    createElement("span", { className: "answer-option-main" },
      createElement("span", { className: "answer-letter" }, `${optionLabel(optionPosition)}.`),
      createElement("span", { className: "answer-text" },
        createRichText(question.options[optionIndex]),
        isSelectedOption && createElement("span", { className: "answer-your-choice" }, "(Your answer)")),
      badge),
    store.settings.showExplanations && explanationText &&
      createElement("span", { className: "answer-explanation", style: null }, createRichText(explanationText)));
}

function renderQuizPage() {
  const quiz = currentQuiz();
  const attempt = quiz?.activeAttempt;
  if (!attempt) {
    applicationState.view = "home";
    return renderHomePage();
  }

  const step = attempt.steps[attempt.position];
  const question = quiz.questions[step.questionIndex];
  const hasAnswered = step.selectedOption !== null;
  const isLastQuestion = attempt.position === attempt.steps.length - 1;
  const isPaused = isQuizPaused(attempt);
  const { correctCount, wrongCount } = calculateScore(quiz, attempt);

  const segments = attempt.steps.map((attemptStep, stepPosition) => {
    let segmentClass = "";
    if (attemptStep.selectedOption !== null) {
      segmentClass = attemptStep.selectedOption === quiz.questions[attemptStep.questionIndex].correctIndex ? "is-correct" : "is-wrong";
    } else if (stepPosition === attempt.position) {
      segmentClass = "is-current";
    }
    return createElement("span", { className: `progress-segment ${segmentClass}` });
  });

  const continueButton = createElement("button", {
    className: "button button-primary", id: "continue-button", type: "button", disabled: !hasAnswered || isPaused, onClick: continueQuiz,
  }, isLastQuestion ? "See results" : "Continue");

  const questionElement = isPaused
    ? createElement("div", { className: "quiz-paused" },
        createElement("p", { className: "quiz-paused-title" }, "Quiz paused"),
        createElement("p", { className: "quiz-paused-time" }, `Time so far: ${formatDuration(elapsedQuizTime(attempt))}`),
        createElement("button", { className: "button button-primary", type: "button", onClick: toggleQuizTimer }, createIcon("play"), "Resume"))
    : createElement("div", { className: `quiz-question ${applicationState.animateQuestion ? "is-entering" : ""}` },
        createElement("p", { className: "question-number" }, `Question ${attempt.position + 1}`),
        createElement("p", { className: "question-prompt" }, createRichText(question.prompt)),
        createElement("div", { className: "answer-list" },
          step.optionOrder.map((optionIndex, optionPosition) => createAnswerOption(question, step, optionIndex, optionPosition))));

  applicationState.animateQuestion = false;

  const timerButton = store.settings.showTimer && createElement("button", {
    className: `timer-button ${isPaused ? "is-paused" : ""}`,
    type: "button",
    title: isPaused ? "Resume timer" : "Pause timer",
    "aria-label": isPaused ? "Resume timer" : "Pause timer",
    onClick: toggleQuizTimer,
  }, createIcon(isPaused ? "play" : "pause"), createElement("span", { id: "quiz-timer" }, formatDuration(elapsedQuizTime(attempt))));

  return createElement("div", { className: "quiz" },
    createElement("header", { className: "quiz-header" },
      createElement("h1", { className: "quiz-title" }, quiz.title),
      createElement("div", { className: "quiz-header-actions" },
        timerButton,
        createElement("button", {
          className: "icon-button", type: "button", title: "Leave quiz", "aria-label": "Leave quiz", onClick: () => navigate("home"),
        }, createIcon("close")))),
    createElement("div", { className: "quiz-progress" },
      createElement("div", { className: "progress-segments", "aria-hidden": "true" }, segments),
      createElement("span", { className: "progress-count" }, `${attempt.position + 1} / ${attempt.steps.length}`),
      createScorePills(correctCount, wrongCount)),
    createElement("div", { className: "quiz-body", id: "quiz-body" }, questionElement),
    createElement("footer", { className: "quiz-footer" },
      attempt.position > 0 && !isPaused && createElement("button", { className: "button button-secondary", type: "button", onClick: goToPreviousQuestion }, "Back"),
      continueButton));
}

/* Results screen */

function createMissedQuestion(question, step) {
  return createElement("article", { className: "missed-question" },
    createElement("p", { className: "missed-question-prompt" }, createRichText(question.prompt)),
    createElement("div", { className: "missed-answer missed-answer-wrong" }, createIcon("close"),
      createElement("span", {}, createRichText(question.options[step.selectedOption]))),
    createElement("div", { className: "missed-answer missed-answer-correct" }, createIcon("check"),
      createElement("span", {}, createRichText(question.options[question.correctIndex]))));
}

function renderResultsPage() {
  const quiz = currentQuiz();
  const attempt = applicationState.finishedAttempt;
  if (!quiz || !attempt) {
    applicationState.view = "home";
    return renderHomePage();
  }

  const { correctCount, wrongCount } = calculateScore(quiz, attempt);
  const totalCount = attempt.steps.length;
  const percentage = Math.round((correctCount / totalCount) * 100);
  const missedSteps = attempt.steps.filter((step) => step.selectedOption !== quiz.questions[step.questionIndex].correctIndex);

  const correctBar = createElement("span", { className: "results-bar-part results-bar-correct" });
  const wrongBar = createElement("span", { className: "results-bar-part results-bar-wrong" });
  correctBar.style.flex = String(correctCount);
  wrongBar.style.flex = String(wrongCount);

  return createElement("div", { className: "page" },
    createElement("div", { className: "page-inner" },
      createElement("header", { className: "page-header" },
        createElement("div", {},
          createElement("h1", { className: "page-title" }, "Quiz complete"),
          createElement("p", { className: "page-subtitle" }, quiz.title))),
      createElement("section", { className: "results-summary" },
        createElement("p", { className: "results-percentage" }, `${percentage}%`),
        createElement("p", { className: "results-caption" }, `${correctCount} of ${totalCount} correct`),
        createElement("div", { className: "results-bar", "aria-hidden": "true" },
          correctCount > 0 && correctBar,
          wrongCount > 0 && wrongBar),
        createElement("div", { className: "results-counts" },
          createElement("div", { className: "results-count-correct" },
            createElement("span", { className: "results-count-value" }, String(correctCount)),
            createElement("span", { className: "results-count-label" }, "Right")),
          createElement("div", { className: "results-count-wrong" },
            createElement("span", { className: "results-count-value" }, String(wrongCount)),
            createElement("span", { className: "results-count-label" }, "Wrong")),
          Number.isFinite(quiz.lastResult?.elapsedMilliseconds) && createElement("div", {},
            createElement("span", { className: "results-count-value" }, formatDuration(quiz.lastResult.elapsedMilliseconds)),
            createElement("span", { className: "results-count-label" }, "Time"))),
        createElement("div", { className: "results-actions" },
          createElement("button", { className: "button button-secondary", type: "button", onClick: () => openQuiz(quiz.id, true) }, "Retake quiz"),
          createElement("button", { className: "button button-primary", type: "button", onClick: () => navigate("home") }, "Done"))),
      missedSteps.length > 0 && createElement("section", {},
        createElement("h2", { className: "section-title" }, "Review what you missed"),
        missedSteps.map((step) => createMissedQuestion(quiz.questions[step.questionIndex], step)))));
}

/* Rendering */

const PAGE_RENDERERS = {
  home: renderHomePage,
  create: renderCreatePage,
  instructions: renderInstructionsPage,
  settings: renderSettingsPage,
  quiz: renderQuizPage,
  results: renderResultsPage,
};

function render() {
  synchronizeQuizTimer();
  const previousScroller = mainContentElement.querySelector(".page, .quiz-body");
  const previousScrollTop = previousScroller ? previousScroller.scrollTop : 0;
  const previousView = mainContentElement.dataset.view;
  const shouldKeepScroll = !applicationState.animateQuestion && previousView === applicationState.view;

  const pageElement = PAGE_RENDERERS[applicationState.view]();
  mainContentElement.dataset.view = applicationState.view;
  mainContentElement.replaceChildren(pageElement);
  renderSidebar();

  if (shouldKeepScroll) {
    const nextScroller = mainContentElement.querySelector(".page, .quiz-body");
    if (nextScroller) nextScroller.scrollTop = previousScrollTop;
  }
  if (applicationState.view === "quiz") {
    const continueButton = document.getElementById("continue-button");
    if (continueButton && !continueButton.disabled) {
      continueButton.focus({ preventScroll: true });
      continueButton.scrollIntoView({ block: "nearest" });
    }
  }
}

/* Keyboard shortcuts */

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (applicationState.view !== "quiz" || event.target.matches("input, textarea")) return;
  const attempt = currentQuiz()?.activeAttempt;
  if (!attempt) return;

  const currentOptionCount = attempt.steps[attempt.position].optionOrder.length;
  if (event.key.toLowerCase() === "p" && store.settings.showTimer && currentOptionCount < 16) {
    toggleQuizTimer();
  } else if (event.key === "Escape") {
    navigate("home");
  } else if (event.key === "ArrowLeft") {
    goToPreviousQuestion();
  } else if (event.key === "Enter" || event.key === "ArrowRight") {
    if (event.key === "Enter" && event.target.matches("button")) return;
    event.preventDefault();
    continueQuiz();
  } else if (/^[a-z0-9]$/i.test(event.key)) {
    const step = attempt.steps[attempt.position];
    const optionPosition = /\d/.test(event.key) ? Number(event.key) - 1 : event.key.toUpperCase().charCodeAt(0) - 65;
    if (optionPosition >= 0 && optionPosition < step.optionOrder.length) {
      selectAnswer(step.optionOrder[optionPosition]);
    }
  }
});

/* A file dropped outside the text box should not replace the app. */
for (const eventName of ["dragover", "drop"]) {
  document.addEventListener(eventName, (event) => event.preventDefault());
}

setInterval(() => {
  updateQuizTimerDisplay();
  if (runningQuizTimer && Date.now() - lastTimerSaveAt >= TIMER_SAVE_INTERVAL_MILLISECONDS) recordRunningQuizTime();
}, TIMER_DISPLAY_INTERVAL_MILLISECONDS);

document.addEventListener("visibilitychange", () => {
  synchronizeQuizTimer();
  updateQuizTimerDisplay();
});
window.addEventListener("pagehide", recordRunningQuizTime);

render();
