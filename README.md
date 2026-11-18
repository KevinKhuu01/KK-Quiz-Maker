# KK Quiz Maker

Turn your notes, slides, or readings into an interactive multiple choice quiz. Generate the questions with any AI chat, paste the JSON into the app, and get instant feedback as you answer.

The app is a static website built with plain HTML, CSS, and JavaScript. It needs no build step, account, or server-side code.

## Features

- Create quizzes by pasting JSON or uploading a `.json` file
- See whether each answer is right as soon as you choose it, with an optional explanation
- Track right and wrong answers during the quiz and review missed questions at the end
- Use a timer that starts automatically and can be paused and resumed
- Resume unfinished quizzes
- Shuffle questions and answers
- Copy a ready-made AI prompt from the Instructions page
- Use it on desktop or phone, with a dark interface and keyboard shortcuts

## Make a quiz

1. Open **Instructions**, choose the number of questions, and click **Copy prompt**.
2. Paste the prompt into an AI chat and attach or paste your course material.
3. Copy the JSON the AI returns.
4. Open **Create**, paste the JSON, and click **Create quiz**.
5. Start the quiz from **Home**.

## JSON format

```json
{
  "title": "Python Basics",
  "questions": [
    {
      "question": "What does `len([1, 2, 3])` return?",
      "options": ["2", "3", "4", "An error"],
      "answer": "B",
      "explanation": "The list contains three items."
    }
  ]
}
```

Each question needs text, at least two options, and exactly one correct answer. `explanation` is optional.

The `answer` can be:

- A letter, such as `"B"`
- The exact option text, such as `"3"`
- A number counted from 0, such as `1`

The importer also accepts a plain array of questions, JSON wrapped in a Markdown code block, and common alternatives such as `prompt`, `choices`, `correctAnswer`, `rationale`, and `isCorrect` on an option.

## Run locally

From the repository root:

```bash
python3 -m http.server 8000 --directory Web
```

Then open <http://localhost:8000>.

## Deploy to Netlify

The website is in the `Web` folder.

- **Manual deploy:** drag the `Web` folder onto your site's **Deploys** page.
- **Deploy from GitHub:** import this repository, leave the build command empty, and set the publish directory to `Web`.

## Data storage

Quizzes, scores, in-progress attempts, and settings are saved in your browser's `localStorage`. They are not uploaded anywhere or shared between devices or browsers.

Clearing site data for the app deletes its saved quizzes, so keep your JSON if you want to restore them later.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `A`–`Z` or `1`–`9` | Choose an answer |
| `Return` | Continue |
| `←` | Previous question |
| `P` | Pause or resume the timer |
| `Esc` | Leave the quiz |

## Project structure

```text
Web/
├── index.html            Page shell and icons
├── app.js                Screens, quiz logic, timer, and saving
├── quiz-parser.js        JSON import and validation
├── styles.css            Dark theme and responsive layout
├── favicon.svg           Browser icon
├── favicon-32.png        Browser icon fallback
└── apple-touch-icon.png  iPhone home screen icon
```
