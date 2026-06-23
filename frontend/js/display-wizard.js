(() => {
  const wizard = document.querySelector('[data-display-wizard]');
  if (!wizard) return;

  const steps = Array.from(wizard.querySelectorAll('[data-display-step]'));
  const nextButton = document.getElementById('displayNext');
  const backButton = document.getElementById('displayBack');
  const restartButton = document.getElementById('displayRestart');
  const nav = document.getElementById('displayWizardNav');
  const result = document.getElementById('displayResult');
  const stepLabel = document.getElementById('displayStepLabel');
  const progress = document.getElementById('displayProgressFill');
  const budgetOptions = document.getElementById('budgetOptions');
  let currentStep = 0;

  const budgetBands = {
    1: ['Under £100', '£100 – £300', '£300 – £600', '£600+'],
    2: ['Under £200', '£200 – £600', '£600 – £1,200', '£1,200+'],
    3: ['Under £300', '£300 – £900', '£900 – £1,800', '£1,800+'],
    4: ['Under £400', '£400 – £1,200', '£1,200 – £2,400', '£2,400+'],
  };

  const getValue = (name) => wizard.querySelector(`input[name="${name}"]:checked`)?.value || '';
  const selectedNameForStep = ['display_screens', 'display_use', 'display_budget', 'display_install'];
  const stepComplete = (index) => Boolean(getValue(selectedNameForStep[index]));

  function renderBudgetOptions() {
    const screenCount = Number(getValue('display_screens')) || 1;
    budgetOptions.innerHTML = budgetBands[screenCount].map((label, index) => (
      `<label class="display-option"><input type="radio" name="display_budget" value="${index}"><span><strong>${label}</strong></span></label>`
    )).join('');
  }

  function showStep(index) {
    currentStep = index;
    steps.forEach((step, stepIndex) => { step.hidden = stepIndex !== index; });
    result.hidden = true;
    nav.hidden = false;
    backButton.hidden = index === 0;
    nextButton.disabled = !stepComplete(index);
    nextButton.innerHTML = index === steps.length - 1 ? 'See My Recommendation' : 'Next &rarr;';
    stepLabel.textContent = `Step ${index + 1} of ${steps.length}`;
    progress.style.width = `${((index + 1) / steps.length) * 100}%`;
    if (index === 2) renderBudgetOptions();
  }

  function recommendationFor(tier, useCase) {
    if (useCase === 'window') return { badge: '☀ Sunlight Ready', name: '1200 Nit High Brightness Display', unit: 850, description: 'Designed for shopfronts, bright windows and direct sunlight.', fit: ['Window promotions', 'Direct sunlight', 'Long opening hours'], alternative: { label: 'Indoor alternative', name: 'Grade A Commercial Display', unit: 420, description: 'A lower-cost option for shaded or indoor-facing windows.' } };
    const recommendations = [
      { badge: '⭐ Best Value', name: 'Professionally Tested Display', unit: 90, description: 'A carefully tested, cost-effective display for indoor businesses.' },
      { badge: '⭐ Best Value', name: 'Grade A Refurbished Commercial Display', unit: 240, description: 'Commercial reliability with excellent value for everyday indoor use.' },
      { badge: '⭐ Recommended', name: '43" Grade A Commercial Display', unit: 420, description: 'A dependable professional display designed for long daily operating hours.' },
      { badge: '⭐ Premium Choice', name: 'High Brightness Commercial Display', unit: 720, description: 'Extra brightness and commercial durability for demanding locations.' },
    ];
    const chosen = recommendations[tier];
    chosen.fit = useCase === 'menu' ? ['Restaurant menu boards', 'Indoor displays', 'Long operating hours'] : ['Promotional content', 'Customer information', 'Indoor business displays'];
    chosen.alternative = tier < 3 ? { label: 'Upgrade', name: 'High Brightness Commercial Display', unit: 720, description: 'Brighter output and better visibility in strongly lit spaces.' } : { label: 'Value alternative', name: 'Grade A Commercial Display', unit: 420, description: 'A strong lower-cost option for normal indoor lighting.' };
    return chosen;
  }

  function money(value) { return `£${value.toLocaleString('en-GB')}`; }

  function showResult() {
    const screens = Number(getValue('display_screens'));
    const useCase = getValue('display_use');
    const tier = Number(getValue('display_budget'));
    const installation = getValue('display_install');
    const recommendation = recommendationFor(tier, useCase);
    const displayTotal = recommendation.unit * screens;
    const playerTotal = 60 * screens;
    const installationTotal = installation === 'arranged' ? 50 * screens : 0;
    const total = displayTotal + playerTotal + installationTotal;

    document.getElementById('recommendationBadge').textContent = recommendation.badge;
    document.getElementById('recommendationName').textContent = `${screens > 1 ? `${screens} × ` : ''}${recommendation.name}`;
    document.getElementById('recommendationDescription').textContent = recommendation.description;
    document.getElementById('recommendationFit').innerHTML = recommendation.fit.map(item => `<li>${item}</li>`).join('');
    document.getElementById('displayCost').textContent = money(displayTotal);
    document.getElementById('playerCost').textContent = money(playerTotal);
    document.getElementById('installationCost').textContent = installationTotal ? money(installationTotal) : 'Self installation';
    document.getElementById('estimatedTotal').textContent = `From ${money(total)}`;
    document.getElementById('alternativeLabel').textContent = recommendation.alternative.label;
    document.getElementById('alternativeName').textContent = recommendation.alternative.name;
    document.getElementById('alternativeDescription').textContent = recommendation.alternative.description;
    document.getElementById('alternativeCost').textContent = `From ${money(recommendation.alternative.unit * screens + playerTotal)}`;
    const quoteParams = new URLSearchParams({ screens: String(screens), use: useCase, display: recommendation.name, install: installation });
    document.getElementById('displayQuoteLink').href = `/contact.html?${quoteParams.toString()}#setup-plan`;

    steps.forEach(step => { step.hidden = true; });
    nav.hidden = true;
    result.hidden = false;
    stepLabel.textContent = 'Your recommendation';
    progress.style.width = '100%';
  }

  wizard.addEventListener('change', (event) => {
    if (event.target.matches('input[type="radio"]')) {
      const group = wizard.querySelectorAll(`input[name="${event.target.name}"]`);
      group.forEach(input => input.closest('.display-option').classList.toggle('is-selected', input.checked));
      nextButton.disabled = !stepComplete(currentStep);
    }
  });
  nextButton.addEventListener('click', () => {
    if (!stepComplete(currentStep)) return;
    if (currentStep === steps.length - 1) showResult();
    else showStep(currentStep + 1);
  });
  backButton.addEventListener('click', () => { if (currentStep > 0) showStep(currentStep - 1); });
  restartButton.addEventListener('click', () => { wizard.querySelectorAll('input[type="radio"]').forEach(input => { input.checked = false; }); wizard.querySelectorAll('.display-option').forEach(option => option.classList.remove('is-selected')); showStep(0); });
  showStep(0);
})();
