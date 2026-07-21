export function normalizeAnswerIndices(answer) {
  const values = Array.isArray(answer) ? answer : [answer];

  return [...new Set(values
    .map(value => Number.parseInt(value, 10))
    .filter(value => Number.isInteger(value) && value >= 0))]
    .sort((left, right) => left - right);
}

export function getCorrectAnswerIndices(question) {
  return normalizeAnswerIndices(question?.ans);
}

export function isMultiAnswerQuestion(question) {
  return getCorrectAnswerIndices(question).length > 1;
}

export function normalizeSelectedAnswer(selected) {
  if (Array.isArray(selected)) {
    return normalizeAnswerIndices(selected);
  }

  const value = Number.parseInt(selected, 10);
  if (!Number.isInteger(value) || value < 0) {
    return [];
  }

  return [value];
}

export function isoDateToDDMMYYYY(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-");
  if (!year || !month || !day) return null;
  return `${day}/${month}/${year}`;
}

export function ddmmyyyyToIsoDate(dateValue) {
  const [day, month, year] = String(dateValue || "").split("/");
  if (!day || !month || !year) return "";
  return `${year}-${month}-${day}`;
}

export function areAnswersEqual(question, selected) {
  const correctIndices = getCorrectAnswerIndices(question);
  const selectedIndices = normalizeSelectedAnswer(selected);

  if (!correctIndices.length) return false;
  if (correctIndices.length !== selectedIndices.length) return false;

  return correctIndices.every((value, index) => value === selectedIndices[index]);
}
