import {test,expect} from './fixtures';
const scenarios=[
  {button:'Track a habit',required:[/habit tracker/i,/form/i,/collection/i,/complete/i,/undo/i,/delete/i,/local storage/i,/no network/i]},
  {button:'Manage expenses',required:[/monthly expense tracker/i,/numeric amount/i,/budget input/i,/total spending/i,/remaining budget/i,/delet/i,/local storage/i,/no network/i]},
  {button:'Make a list',required:[/task list/i,/form/i,/complete/i,/undo/i,/edit/i,/delete/i,/local storage/i,/no external/i]},
] as const;
for(const scenario of scenarios){
 test('starter '+scenario.button+' communicates full declarative local workflow without submitting AI',async({page})=>{
  await page.goto('/');
  await expect(page.getByText('Local runtime ready',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:scenario.button,exact:true}).click();
  const text=await page.getByLabel('Describe your application').inputValue();
  for(const required of scenario.required)expect(text).toMatch(required);
  expect(text.length).toBeGreaterThan(160);
  const permission=page.getByLabel(/Send this description|Use the authored test provider/);
  if(await permission.count())await expect(permission).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Create application',exact:true})).toBeDisabled();
 });
}
