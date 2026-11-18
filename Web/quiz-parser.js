"use strict";

/*
 * Turns pasted or uploaded JSON into the quiz shape the app uses:
 * { title, questions: [{ prompt, options, correctIndex, explanation, optionExplanations }] }
 *
 * It accepts the field names that AI tools and quiz exports commonly use,
 * and reports problems by question number.
 */
const QuizParser = (() => {
  const TITLE_FIELDS = ["title", "name", "quizTitle", "quizName"];
  const QUESTION_LIST_FIELDS = ["questions", "quiz", "items", "data"];
  const PROMPT_FIELDS = ["question", "prompt", "questionText", "stem", "text", "q"];
  const OPTION_LIST_FIELDS = ["options", "answerOptions", "choices", "answers", "alternatives"];
  const CORRECT_ANSWER_FIELDS = [
    "correctAnswer", "correct", "correctOption", "correctChoice", "correctIndex",
    "correctAnswerIndex", "answerIndex", "answer", "solution",
  ];
  const EXPLANATION_FIELDS = ["explanation", "rationale", "reason", "why", "feedback"];
  const OPTION_TEXT_FIELDS = ["text", "option", "label", "value", "content", "answer", "choice"];
  const OPTION_CORRECT_FIELDS = ["isCorrect", "correct", "isAnswer", "isRight", "right"];

  function normalizeFieldName(fieldName) {
    return String(fieldName).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function readField(sourceObject, fieldNames) {
    const entries = Object.entries(sourceObject);
    for (const fieldName of fieldNames) {
      const normalizedName = normalizeFieldName(fieldName);
      const matchingEntry = entries.find(([key, value]) =>
        normalizeFieldName(key) === normalizedName && value !== undefined && value !== null);
      if (matchingEntry) return matchingEntry[1];
    }
    return undefined;
  }

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isTextValue(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
  }

  function cleanText(value) {
    return isTextValue(value) ? String(value).trim() : "";
  }

  function comparableText(value) {
    return cleanText(value).toLowerCase().replace(/\s+/g, " ");
  }

  /* AI tools often wrap JSON in a Markdown code fence. */
  function removeCodeFence(rawText) {
    const trimmedText = rawText.replace(/^﻿/, "").trim();
    const fenceMatch = trimmedText.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
    return fenceMatch ? fenceMatch[1].trim() : trimmedText;
  }

  function findQuestionList(parsedValue) {
    if (Array.isArray(parsedValue)) return parsedValue;
    if (!isPlainObject(parsedValue)) return null;
    const questionList = readField(parsedValue, QUESTION_LIST_FIELDS);
    if (Array.isArray(questionList)) return questionList;
    if (isPlainObject(questionList)) return findQuestionList(questionList);
    if (readField(parsedValue, OPTION_LIST_FIELDS) !== undefined) return [parsedValue];
    return null;
  }

  function findTitle(parsedValue) {
    if (!isPlainObject(parsedValue)) return "";
    const directTitle = cleanText(readField(parsedValue, TITLE_FIELDS));
    if (directTitle) return directTitle;
    const nestedQuiz = readField(parsedValue, ["quiz"]);
    return isPlainObject(nestedQuiz) ? findTitle(nestedQuiz) : "";
  }

  function normalizeOption(rawOption, optionKey) {
    if (isTextValue(rawOption)) {
      return { text: cleanText(rawOption), key: optionKey, isMarkedCorrect: false, explanation: "" };
    }
    if (!isPlainObject(rawOption)) {
      return { text: "", key: optionKey, isMarkedCorrect: false, explanation: "" };
    }
    let optionText = cleanText(readField(rawOption, OPTION_TEXT_FIELDS));
    let resolvedKey = optionKey;
    const entries = Object.entries(rawOption);
    if (!optionText && entries.length === 1 && isTextValue(entries[0][1])) {
      resolvedKey = entries[0][0];
      optionText = cleanText(entries[0][1]);
    }
    const correctFlag = readField(rawOption, OPTION_CORRECT_FIELDS);
    return {
      text: optionText,
      key: resolvedKey,
      isMarkedCorrect: correctFlag === true || comparableText(correctFlag) === "true",
      explanation: cleanText(readField(rawOption, EXPLANATION_FIELDS)),
    };
  }

  function normalizeOptions(rawOptions) {
    if (Array.isArray(rawOptions)) {
      return rawOptions.map((rawOption) => normalizeOption(rawOption, null));
    }
    if (isPlainObject(rawOptions)) {
      return Object.entries(rawOptions).map(([optionKey, rawOption]) => normalizeOption(rawOption, optionKey));
    }
    return [];
  }

  /* Removes "A. " style prefixes because the quiz screen adds its own letters. */
  function removeLetterPrefixes(options) {
    const hasSequentialPrefixes = options.length > 0 && options.every((option, optionIndex) => {
      const prefixMatch = option.text.match(/^([A-Za-z])[.)]\s+\S/);
      return prefixMatch && prefixMatch[1].toUpperCase() === String.fromCharCode(65 + optionIndex);
    });
    return options.map((option) => ({
      ...option,
      originalText: option.text,
      text: hasSequentialPrefixes ? option.text.replace(/^[A-Za-z][.)]\s+/, "") : option.text,
    }));
  }

  function letterToIndex(letter) {
    return letter.toUpperCase().charCodeAt(0) - 65;
  }

  function resolveAnswerText(answerText, options) {
    const comparableAnswer = comparableText(answerText);
    const exactIndex = options.findIndex((option) =>
      comparableText(option.text) === comparableAnswer ||
      comparableText(option.originalText) === comparableAnswer ||
      (option.key !== null && comparableText(option.key) === comparableAnswer));
    if (exactIndex !== -1) return exactIndex;

    const trimmedAnswer = answerText.trim();
    const letterMatch = trimmedAnswer.match(/^(?:(?:option|answer|choice)\s*:?\s*)?\(?([A-Za-z])\)?[.):]?$/i);
    if (letterMatch) return letterToIndex(letterMatch[1]);
    if (/^\d+$/.test(trimmedAnswer)) return Number(trimmedAnswer);

    const letterWithTextMatch = trimmedAnswer.match(/^\(?([A-Za-z])[.):]\)?\s+(.+)$/s);
    if (letterWithTextMatch) {
      const textWithoutLetter = comparableText(letterWithTextMatch[2]);
      return options.findIndex((option) => comparableText(option.text) === textWithoutLetter);
    }
    return -1;
  }

  function resolveCorrectIndex(rawQuestion, options) {
    const markedIndexes = options.flatMap((option, optionIndex) => (option.isMarkedCorrect ? [optionIndex] : []));
    if (markedIndexes.length > 1) {
      return { problem: "has more than one option marked correct" };
    }
    if (markedIndexes.length === 1) return { correctIndex: markedIndexes[0] };

    let correctValue = readField(rawQuestion, CORRECT_ANSWER_FIELDS);
    if (correctValue === undefined) return { problem: "does not say which answer is correct" };
    if (Array.isArray(correctValue)) {
      if (correctValue.length !== 1) return { problem: "must have exactly one correct answer" };
      correctValue = correctValue[0];
    }
    if (isPlainObject(correctValue)) correctValue = readField(correctValue, OPTION_TEXT_FIELDS);

    if (typeof correctValue === "number") {
      if (Number.isInteger(correctValue) && correctValue >= 0 && correctValue < options.length) {
        return { correctIndex: correctValue };
      }
      return {
        problem: `has answer number ${correctValue}, but numbers count from 0 and must be below ${options.length}`,
      };
    }
    if (!isTextValue(correctValue)) return { problem: "does not say which answer is correct" };

    const resolvedIndex = resolveAnswerText(String(correctValue), options);
    if (resolvedIndex < 0 || resolvedIndex >= options.length) {
      return { problem: `has the answer "${cleanText(correctValue)}", which does not match any option` };
    }
    return { correctIndex: resolvedIndex };
  }

  function normalizeQuestion(rawQuestion, questionNumber) {
    const label = `Question ${questionNumber}`;
    if (!isPlainObject(rawQuestion)) return { problem: `${label} is not an object.` };

    const prompt = cleanText(readField(rawQuestion, PROMPT_FIELDS));
    if (!prompt) return { problem: `${label} has no question text.` };

    const options = removeLetterPrefixes(normalizeOptions(readField(rawQuestion, OPTION_LIST_FIELDS)));
    if (options.length < 2) return { problem: `${label} needs at least 2 answer options.` };
    const emptyOptionIndex = options.findIndex((option) => !option.text);
    if (emptyOptionIndex !== -1) {
      return { problem: `${label}: option ${emptyOptionIndex + 1} has no text.` };
    }

    const correctAnswer = resolveCorrectIndex(rawQuestion, options);
    if (correctAnswer.problem) return { problem: `${label} ${correctAnswer.problem}.` };

    return {
      question: {
        prompt,
        options: options.map((option) => option.text),
        correctIndex: correctAnswer.correctIndex,
        explanation: cleanText(readField(rawQuestion, EXPLANATION_FIELDS)),
        optionExplanations: options.map((option) => option.explanation),
      },
    };
  }

  function parse(rawText) {
    const jsonText = removeCodeFence(rawText);
    if (!jsonText) return { isValid: false, isEmpty: true, problems: [] };

    let parsedValue;
    try {
      parsedValue = JSON.parse(jsonText);
    } catch (parseError) {
      return { isValid: false, problems: [`This is not valid JSON. ${parseError.message}`] };
    }

    const questionList = findQuestionList(parsedValue);
    if (!questionList) {
      return { isValid: false, problems: ['Could not find a list of questions. Use an array, or an object with a "questions" array.'] };
    }
    if (questionList.length === 0) {
      return { isValid: false, problems: ["The question list is empty."] };
    }

    const questions = [];
    const problems = [];
    questionList.forEach((rawQuestion, questionIndex) => {
      const result = normalizeQuestion(rawQuestion, questionIndex + 1);
      if (result.problem) problems.push(result.problem);
      else questions.push(result.question);
    });

    if (problems.length > 0) return { isValid: false, problems };
    return { isValid: true, title: findTitle(parsedValue), questions, problems: [] };
  }

  return { parse };
})();
