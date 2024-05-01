import { type Locator, type Page, expect } from '@playwright/test'
import { NewToDo, Slot } from './types'
import { CalendarPage } from '../calendar-page'

export class PlanningPage extends CalendarPage {
  readonly page: Page

  constructor (page: Page) {
    super(page)
    this.page = page
  }

  private readonly popup = (): Locator => this.page.locator('div.popup')
  private readonly panel = (): Locator => this.page.locator('div.hulyModal-container')
  private readonly toDosContainer = (): Locator => this.page.locator('div.toDos-container')
  readonly pageHeader = (): Locator =>
    this.page.locator('div[class*="navigator"] div[class*="header"]', { hasText: 'Planning' })

  readonly buttonCreateNewToDo = (): Locator => this.toDosContainer().locator('button.button')
  readonly inputPopupCreateTitle = (): Locator => this.popup().locator('input[type="text"]')
  readonly inputPopupCreateDescription = (): Locator => this.popup().locator('div.tiptap')
  readonly inputPanelCreateDescription = (): Locator => this.panel().locator('div.tiptap')
  readonly buttonPopupCreateDueDate = (): Locator =>
    this.popup().locator('div.block:first-child div.flex-row-center button:nth-child(3)')

  readonly buttonPanelCreateDueDate = (): Locator =>
    this.panel().locator('div.slots-content div.flex-row-top.justify-between div.flex-row-center button:first-child')

  readonly buttonPopupCreatePriority = (): Locator => this.popup().locator('button#priorityButton')
  readonly buttonPanelCreatePriority = (): Locator => this.panel().locator('button#priorityButton')
  readonly buttonPopupCreateVisible = (): Locator => this.popup().locator('button#visibleButton')
  readonly buttonPanelCreateVisible = (): Locator => this.panel().locator('button#visibleButton')
  readonly buttonPopupCreateAddLabel = (): Locator =>
    this.popup().locator('button.antiButton', { hasText: 'Add label' })

  readonly buttonPanelCreateAddLabel = (): Locator =>
    this.panel().locator('.hulyHeader-titleGroup > button:nth-child(2)')

  readonly buttonPopupCreateAddSlot = (): Locator => this.popup().locator('button', { hasText: 'Add Slot' })
  readonly buttonPanelCreateAddSlot = (): Locator => this.panel().locator('button', { hasText: 'Add Slot' })
  readonly buttonCalendarToday = (): Locator => this.popup().locator('div.calendar button.day.today')
  readonly buttonCreateToDo = (): Locator => this.popup().locator('button.antiButton', { hasText: 'Add ToDo' })
  readonly inputCreateToDoTitle = (): Locator =>
    this.toDosContainer().locator('input[placeholder="Add todo, press Enter to save"]')

  readonly buttonCardClose = (): Locator =>
    this.panel().locator('.hulyHeader-container > .hulyHeader-buttonsGroup > .font-medium-14')

  readonly textPanelToDoTitle = (): Locator =>
    this.panel().locator('div.top-content label.editbox-wrapper.ghost.large input')

  readonly textPanelToDoDescription = (): Locator => this.panel().locator('div.top-content div.tiptap > p')
  readonly textPanelDueDate = (): Locator =>
    this.panel().locator(
      'div.slots-content div.flex-row-top.justify-between div.flex-row-center button:first-child span'
    )

  readonly textPanelPriority = (): Locator => this.panel().locator('button#priorityButton svg')
  readonly textPanelVisible = (): Locator =>
    this.panel().locator('div.hulyHeader-titleGroup > button:nth-child(3) > span')

  readonly buttonPanelLabelFirst = (): Locator =>
    this.panel().locator('div.hulyHeader-titleGroup > button:nth-child(2)')

  readonly buttonMenuDelete = (): Locator => this.page.locator('button.ap-menuItem span', { hasText: 'Delete' })
  readonly buttonPopupSelectDateNextMonth = (): Locator =>
    this.popup().locator('div.header > div:last-child > button:last-child')

  async clickButtonCreateAddSlot (): Promise<void> {
    await this.buttonPanelCreateAddSlot().click({ force: true })
  }

  async clickButtonCardClose (): Promise<void> {
    await this.buttonCardClose().click()
  }

  async createNewToDoFromInput (title: string): Promise<void> {
    await this.inputCreateToDoTitle().fill(title)
    await this.page.keyboard.press('Enter')
  }

  async createNewToDo (data: NewToDo): Promise<void> {
    await this.buttonCreateNewToDo().click()

    await this.inputPopupCreateTitle().fill(data.title)
    await this.updateToDo(data, true)

    await this.buttonCreateToDo().click()
  }

  async updateToDo (data: NewToDo, popup: boolean = false): Promise<void> {
    if (data.description != null) {
      await (popup
        ? this.inputPopupCreateDescription().fill(data.description)
        : this.inputPanelCreateDescription().fill(data.description))
    }
    if (data.duedate != null) {
      await (popup ? this.buttonPopupCreateDueDate().click() : this.buttonPanelCreateDueDate().click())
      if (data.duedate === 'today') {
        await this.clickButtonDatePopupToday()
      } else {
        await this.selectMenuItem(this.page, data.duedate)
      }
    }
    if (data.priority != null) {
      await (popup ? this.buttonPopupCreatePriority().click() : this.buttonPanelCreatePriority().click())
      await this.selectListItem(data.priority)
    }
    if (data.visible != null) {
      await (popup ? this.buttonPopupCreateVisible().click() : this.buttonPanelCreateVisible().click())
      await this.selectPopupItem(data.visible)
    }
    if (data.labels != null && data.createLabel != null) {
      await (popup ? this.buttonPopupCreateAddLabel().click() : this.buttonPanelCreateAddLabel().click())
      if (data.createLabel) {
        await this.pressCreateButtonSelectPopup()
        await this.addNewTagPopup(this.page, data.labels, 'Tag from createNewIssue')
        await this.page.locator('.popup#TagsPopup').press('Escape')
      } else {
        await this.checkFromDropdownWithSearch(this.page, data.labels)
      }
    }
    if (data.slots != null) {
      let index = 0
      for (const slot of data.slots) {
        await (popup
          ? this.buttonPopupCreateAddSlot().click({ force: true })
          : this.buttonPanelCreateAddSlot().click({ force: true }))
        await this.setTimeSlot(index, slot, popup)
        index++
      }
    }
  }

  public async setTimeSlot (rowNumber: number, slot: Slot, popup: boolean = false): Promise<void> {
    const p = popup
      ? 'div.popup div.horizontalBox div.end div.scroller-container div.box div.flex-between.min-w-full'
      : 'div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full'
    const row = this.page.locator(p).nth(rowNumber)

    // dateStart
    await row.locator('div.dateEditor-container:first-child > div.min-w-28:first-child button').click()
    if (slot.dateStart === 'today') {
      await this.buttonCalendarToday().click()
    } else {
      if (slot.dateStart === '1') {
        await this.buttonPopupSelectDateNextMonth().click()
      }
      await this.page
        .locator('div.popup div.calendar button.day')
        .filter({ has: this.page.locator(`text="${slot.dateStart}"`) })
        .click()
    }
    // timeStart
    const hours = slot.timeStart.substring(0, 2)
    const minutes = slot.timeStart.substring(2, slot.timeStart.length)
    await row
      .locator('div.dateEditor-container:nth-child(1) button:last-child span.digit:first-child')
      .click({ delay: 200 })
    await row
      .locator('div.dateEditor-container:nth-child(1) button:last-child span.digit:first-child')
      .pressSequentially(hours, { delay: 100 })
    await row
      .locator('div.dateEditor-container:nth-child(1) button:last-child span.digit:last-child')
      .click({ delay: 200 })
    await row
      .locator('div.dateEditor-container:nth-child(1) button:last-child span.digit:last-child')
      .pressSequentially(minutes, { delay: 100 })

    // dateEnd + timeEnd
    await row.locator('div.dateEditor-container.difference button').click()
    await this.fillSelectDatePopup(slot.dateEnd.day, slot.dateEnd.month, slot.dateEnd.year, slot.timeEnd)
  }

  private async checkTimeSlot (rowNumber: number, slot: Slot, popup: boolean = false): Promise<void> {
    const p = popup
      ? 'div.popup div.horizontalBox div.end div.scroller-container div.box div.flex-between.min-w-full'
      : 'div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full'
    const row = this.page.locator(p).nth(rowNumber)
    // timeStart
    await expect(row.locator('div.dateEditor-container:nth-child(1) button:last-child div.datetime-input')).toHaveText(
      slot.timeStart
    )
    // timeEnd
    await expect(row.locator('div.dateEditor-container.difference button > div:first-child')).toHaveText(slot.timeEnd)
  }

  async openToDoByName (toDoName: string): Promise<void> {
    await this.page.locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName }).click()
  }

  async checkToDoNotExist (toDoName: string): Promise<void> {
    await expect(
      this.page.locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
    ).toHaveCount(0)
  }

  async checkToDoExist (toDoName: string): Promise<void> {
    await expect(
      this.page.locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
    ).toHaveCount(1)
  }

  async checkToDo (data: NewToDo): Promise<void> {
    await expect(this.textPanelToDoTitle()).toHaveValue(data.title)
    if (data.description != null) {
      await expect(this.textPanelToDoDescription()).toHaveText(data.description)
    }
    if (data.duedate != null) {
      await expect(this.textPanelDueDate()).toHaveText(data.duedate)
    }
    if (data.priority != null) {
      const classAttribute = await this.textPanelPriority().getAttribute('class')
      expect(classAttribute).toContain(data.priority)
    }
    if (data.visible != null) {
      await expect(this.textPanelVisible()).toHaveText(data.visible)
    }
    if (data.labels != null) {
      await this.buttonPanelLabelFirst().click()
      await this.checkPopupItem(data.labels)
      await this.buttonPanelLabelFirst().click({ force: true })
    }
    if (data.slots != null) {
      let index = 0
      for (const slot of data.slots) {
        await this.checkTimeSlot(index, slot)
        index++
      }
    }
  }

  async deleteToDoByName (toDoName: string): Promise<void> {
    await this.page.locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName }).hover()
    await this.page
      .locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
      .locator('xpath=..')
      .locator('div.hulyToDoLine-statusPriority button.hulyToDoLine-dragbox')
      .click({ button: 'right' })
    await this.buttonMenuDelete().click()
    await this.pressYesDeletePopup()
  }

  async selectToDoByName (toDoName: string): Promise<void> {
    await this.page
      .locator('button.hulyToDoLine-container div[class$="overflow-label"]', { hasText: toDoName })
      .locator('xpath=..')
      .locator('div.hulyToDoLine-checkbox > label')
      .click()
  }

  async checkToDoExistInCalendar (toDoName: string, count: number): Promise<void> {
    await expect(
      this.page.locator('div.calendar-element > div.event-container >> div[class*="label"]', { hasText: toDoName })
    ).toHaveCount(count)
  }

  public async deleteTimeSlot (rowNumber: number): Promise<void> {
    const row = this.page
      .locator(
        'div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full div.tool'
      )
      .nth(rowNumber)
    await row.locator('xpath=..').hover()
    await row.locator('button').click()
    await this.pressYesDeletePopup()
  }

  public async checkTimeSlotEndDate (rowNumber: number, dateEnd: string): Promise<void> {
    const row = this.page
      .locator('div.hulyModal-container div.slots-content div.scroller-container div.box div.flex-between.min-w-full')
      .nth(rowNumber)
    // dateEnd
    await expect(row.locator('div.dateEditor-container:first-child > div.min-w-28:first-child button')).toContainText(
      dateEnd
    )
  }
}
