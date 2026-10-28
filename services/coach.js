const ledger = require('./ledger');

const money = value => `₹${Math.round(Number(value) || 0).toLocaleString('en-IN')}`;
const monthKey = date => date.toISOString().slice(0, 7);
const categoryAliases = [
  [['food', 'dining', 'restaurant', 'delivery', 'swiggy', 'zomato'], 'Food & Dining'],
  [['grocery', 'groceries', 'bigbasket', 'blinkit', 'zepto'], 'Groceries'],
  [['shopping', 'amazon', 'flipkart', 'clothes'], 'Shopping'],
  [['transport', 'travel', 'uber', 'ola', 'fuel', 'cab'], 'Transport'],
  [['bill', 'utility', 'airtel', 'jio', 'electricity', 'internet'], 'Bills & Utilities'],
  [['entertainment', 'netflix', 'spotify', 'movie'], 'Entertainment'],
  [['health', 'medical', 'pharmacy'], 'Health'],
  [['education', 'college', 'course', 'book'], 'Education'],
  [['finance', 'bank fee', 'charge'], 'Finance']
];

function classifyQuestion(question) {
  const text = String(question || '').toLowerCase();
  for (const [aliases, category] of categoryAliases) if (aliases.some(alias => text.includes(alias))) return category;
  return null;
}

function respond(transactions, question, now = new Date()) {
  const text = String(question || '').trim().toLowerCase();
  if (!transactions.length) return {
    answer: 'I don’t have any transactions to analyze yet. Import a UPI or bank statement, and I can summarize your spending, categories, and recurring payments.',
    evidence: 'Your ledger has no saved transactions.'
  };

  const currentMonth = monthKey(now);
  const current = transactions.filter(item => String(item.date).startsWith(currentMonth));
  const expenses = current.filter(item => item.type === 'EXPENSE');
  const spent = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const income = current.filter(item => item.type === 'INCOME').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const categoryTotals = new Map();
  for (const item of expenses) categoryTotals.set(item.category, (categoryTotals.get(item.category) || 0) + Number(item.amount || 0));
  const topCategories = [...categoryTotals].sort((a, b) => b[1] - a[1]);
  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' });
  const category = classifyQuestion(text);
  const categorySpend = category ? categoryTotals.get(category) || 0 : null;

  if (/(recurr|subscription|monthly charge|regular payment)/.test(text)) {
    const recurring = ledger.findRecurring(transactions);
    if (!recurring.length) return { answer: 'I haven’t found a clear recurring-payment pattern yet. I need repeated charges to the same merchant with similar amounts before I can flag one.', evidence: 'Recurring detection checks merchant, amount, and transaction intervals.' };
    const monthly = recurring.reduce((sum, item) => sum + item.monthlyAmount, 0);
    const top = recurring.slice(0, 3).map(item => `${item.merchant} (${money(item.amount)} ${item.frequency})`).join(', ');
    return { answer: `I found ${recurring.length} possible recurring payment${recurring.length === 1 ? '' : 's'}, estimated at about ${money(monthly)} per month. The largest matches are ${top}. Review them before treating them as confirmed subscriptions.`, evidence: `${recurring.reduce((sum, item) => sum + item.count, 0)} repeated charges across ${recurring.length} merchants.` };
  }

  if (category && /(spend|spent|much|where|save|reduce|cut|budget|cost)/.test(text)) {
    const categoryCount = expenses.filter(item => item.category === category).length;
    if (!categoryCount) return { answer: `There are no ${category} expenses recorded for ${monthLabel} so far. That is based only on transactions currently in your LedgerLoom account.`, evidence: 'No matching expense transactions this month.' };
    const saveAmount = categorySpend * 0.1;
    const suggestion = /(save|reduce|cut|budget)/.test(text) ? ` If you chose to reduce this category by 10%, that would be about ${money(saveAmount)} this month; it’s only a what-if estimate, not a guaranteed saving.` : '';
    return { answer: `You recorded ${money(categorySpend)} across ${categoryCount} ${category} expense${categoryCount === 1 ? '' : 's'} in ${monthLabel}.${suggestion}`, evidence: `${categoryCount} matching transactions in ${currentMonth}.` };
  }

  if (/(income|remaining|left over|leftover|balance|net)/.test(text)) {
    return { answer: `For ${monthLabel}, your recorded income is ${money(income)} and recorded expenses are ${money(spent)}. The difference is ${money(income - spent)}. This is only the difference in transactions you imported; it is not a live bank balance.`, evidence: `${current.filter(item => item.type === 'INCOME').length} income and ${expenses.length} expense transactions this month.` };
  }

  if (/(save|saving|reduce|cut|budget|consume|spend less|improve)/.test(text) && topCategories.length) {
    const [top, amount] = topCategories[0];
    const variable = topCategories.find(([name]) => ['Food & Dining', 'Shopping', 'Entertainment'].includes(name)) || topCategories[0];
    const estimate = variable[1] * 0.1;
    return { answer: `${top} is your largest category this ${monthLabel} at ${money(amount)}. If your goal is to spend less, you could review one flexible category—${variable[0]} is currently ${money(variable[1])}—and choose a limit that feels realistic. A 10% reduction would be about ${money(estimate)} for this month, as a simple scenario.`, evidence: `${expenses.length} expenses this month; largest category: ${top}.` };
  }

  if (/(where|category|biggest|top|main|most)/.test(text) && topCategories.length) {
    const summary = topCategories.slice(0, 3).map(([name, amount]) => `${name}: ${money(amount)}`).join('; ');
    return { answer: `You recorded ${money(spent)} in expenses for ${monthLabel}. Your largest categories are ${summary}. Transfers, income, and refunds aren’t counted as spending here.`, evidence: `${expenses.length} expense transactions in ${currentMonth}.` };
  }

  return {
    answer: `For ${monthLabel}, I can see ${money(spent)} in recorded expenses${topCategories[0] ? `, led by ${topCategories[0][0]} at ${money(topCategories[0][1])}` : ''}. Ask me about a category, spending less, income versus expenses, or possible recurring payments.`,
    evidence: `${expenses.length} expense transactions this month; analysis uses up to the latest ${transactions.length} saved transactions.`
  };
}

module.exports = { respond, classifyQuestion };
