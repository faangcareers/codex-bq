const form = document.getElementById("job-form");
const statusBox = document.getElementById("status");
const results = document.getElementById("results");
const roleLevel = document.getElementById("role-level");
const roleFocus = document.getElementById("role-focus");
const questionList = document.getElementById("question-list");
const jobTextInput = document.getElementById("job-text");

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
    });

    wrapper.appendChild(list);
    questionList.appendChild(wrapper);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  results.classList.add("hidden");

  const url = document.getElementById("job-url").value.trim();
  const text = jobTextInput.value.trim();
  if (!url && text.length < 200) {
    setStatus("Please enter a job link or paste at least 200 characters of job text.", "error");
    return;
  }

  setStatus("Analyzing job posting... This can take 15-30 seconds.");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, text })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unexpected error.");
    }

    renderResults(data.analysis);
    clearStatus();
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  }
});
