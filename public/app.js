const form = document.getElementById("job-form");
const statusBox = document.getElementById("status");
const results = document.getElementById("results");
const roleLevel = document.getElementById("role-level");
const roleFocus = document.getElementById("role-focus");
const questionList = document.getElementById("question-list");
const jobTextInput = document.getElementById("job-text");
const moreBtn = document.getElementById("more-btn");
const quizBtn = document.getElementById("quiz-btn");
const quizModal = document.getElementById("quiz-modal");
const quizTimer = document.getElementById("quiz-timer");
const quizQuestion = document.getElementById("quiz-question");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const closeBtn = document.getElementById("close-btn");

let lastPayload = null;
let lastQuestions = [];
let quizIndex = 0;
let quizSeconds = 120;
let quizInterval = null;

function setStatus(message, type = "info") {
  statusBox.textContent = message;
  statusBox.classList.remove("hidden", "error");
  if (type === "error") {
    statusBox.classList.add("error");
  }
}

function clearStatus() {
  statusBox.textContent = "";
  statusBox.classList.add("hidden");
  statusBox.classList.remove("error");
}

function renderResults(analysis) {
  results.classList.remove("hidden");
  const level = analysis.role_level || "unknown";
  const focus = analysis.focus || "design";

  roleLevel.textContent = level.charAt(0).toUpperCase() + level.slice(1);
  roleFocus.textContent = focus.charAt(0).toUpperCase() + focus.slice(1);
  questionList.innerHTML = "";
  lastQuestions = [];

  (analysis.themes || []).forEach((themeBlock) => {
    const wrapper = document.createElement("div");
    wrapper.className = "theme";

    const title = document.createElement("h3");
    title.textContent = themeBlock.theme || "Theme";
    wrapper.appendChild(title);

    const list = document.createElement("ol");
    (themeBlock.questions || []).forEach((question) => {
      const li = document.createElement("li");
      li.textContent = question;
      list.appendChild(li);
      lastQuestions.push(question);
    });

    wrapper.appendChild(list);
    questionList.appendChild(wrapper);
  });

  moreBtn.disabled = false;
  quizBtn.disabled = false;
}

function startQuiz() {
  if (!lastQuestions.length) {
    setStatus("Generate questions first to start quiz mode.", "error");
    return;
  }

  quizIndex = 0;
  quizSeconds = 120;
  quizModal.classList.remove("hidden");
  updateQuizQuestion();
  startTimer();
}

function updateQuizQuestion() {
  if (!lastQuestions.length) {
    quizQuestion.textContent = "—";
    return;
  }
  const question = lastQuestions[quizIndex % lastQuestions.length];
  quizQuestion.textContent = question;
  prevBtn.disabled = quizIndex <= 0;
  nextBtn.disabled = quizIndex >= lastQuestions.length - 1;
}

function startTimer() {
  clearInterval(quizInterval);
  updateTimer();
  quizInterval = setInterval(() => {
    quizSeconds -= 1;
    if (quizSeconds <= 0) {
      quizSeconds = 0;
      updateTimer();
      clearInterval(quizInterval);
      setStatus("Time is up. Try another question!", "info");
      return;
    }
    updateTimer();
  }, 1000);
}

function updateTimer() {
  const minutes = String(Math.floor(quizSeconds / 60)).padStart(2, "0");
  const seconds = String(quizSeconds % 60).padStart(2, "0");
  quizTimer.textContent = `${minutes}:${seconds}`;
}

function exitQuiz() {
  clearInterval(quizInterval);
  quizModal.classList.add("hidden");
}

async function analyzeJob(payload) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unexpected error.");
  }

  return data.analysis;
}

const formSubmitBtn = form.querySelector('button[type="submit"]');

function setButtonLoading(btn, isLoading, loadingText = "Loading...") {
  if (isLoading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="button-spinner"></span> ${loadingText}`;
  } else {
    btn.innerHTML = btn.dataset.originalText;
    btn.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  results.classList.add("hidden");
  exitQuiz();

  const url = document.getElementById("job-url").value.trim();
  const text = jobTextInput.value.trim();
  if (!url && text.length < 200) {
    setStatus("Please enter a job link or paste at least 200 characters of job text.", "error");
    return;
  }

  setStatus("Analyzing job posting... This can take 15-30 seconds.");
  setButtonLoading(formSubmitBtn, true, "Generating...");

  try {
    lastPayload = { url, text };
    const analysis = await analyzeJob(lastPayload);
    renderResults(analysis);
    clearStatus();
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    setButtonLoading(formSubmitBtn, false);
  }
});

moreBtn.addEventListener("click", async () => {
  if (!lastPayload) {
    setStatus("Please generate questions first.", "error");
    return;
  }

  setStatus("Generating more questions...", "info");
  setButtonLoading(moreBtn, true, "Generating...");
  
  try {
    const analysis = await analyzeJob(lastPayload);
    renderResults(analysis);
    clearStatus();
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  } finally {
    setButtonLoading(moreBtn, false);
  }
});

quizBtn.addEventListener("click", () => {
  startQuiz();
});

prevBtn.addEventListener("click", () => {
  if (!lastQuestions.length) return;
  quizIndex = (quizIndex - 1 + lastQuestions.length) % lastQuestions.length;
  quizSeconds = 120;
  updateQuizQuestion();
  startTimer();
});

nextBtn.addEventListener("click", () => {
  if (quizIndex >= lastQuestions.length - 1) return;
  quizIndex += 1;
  quizSeconds = 120;
  updateQuizQuestion();
  startTimer();
});

function confirmExit() {
  const ok = window.confirm("Are you sure you want to exit quiz mode?");
  if (ok) {
    exitQuiz();
  }
}

closeBtn.addEventListener("click", confirmExit);
quizModal.addEventListener("click", (event) => {
  if (event.target?.dataset?.close === "true") {
    confirmExit();
  }
});

moreBtn.disabled = true;
quizBtn.disabled = true;
