import { Component, OnDestroy, OnInit } from '@angular/core'
import { AlertService, CloudAppEventsService, CloudAppRestService, Entity, EntityType, HttpMethod } from '@exlibris/exl-cloudapp-angular-lib'
import { Observable, of } from 'rxjs'
import { catchError, filter, shareReplay, switchMap, tap } from 'rxjs/operators'
import xmlFormat from 'xml-formatter'
import { BibRecord } from '../models/bib-record'
import { LoadingIndicatorService } from '../services/loading-indicator.service'
import { LogService } from '../services/log.service'
import { StatusMessageService } from '../services/status-message.service.ts'
import { Template } from '../templates/template'
import { TemplateSet } from '../templates/template-set'
import { TemplateSetRegistry } from '../templates/template-set-registry.service'
import { XPathHelperService } from '../services/xpath-helper.service'


@Component({
  selector: 'app-main',
  templateUrl: './main.component.html',
  styleUrls: ['./main.component.scss']
})
export class MainComponent implements OnInit, OnDestroy {

  entities: Entity[]
  selectedEntity: BibRecord
  xml: string
  xmlRecord: Document
  hasChanges: boolean

  entities$: Observable<Entity[]> = this.eventsService.entities$
    .pipe(
      tap(() => this.reset()),
      filter(entites => entites.every(entity => entity.type === EntityType.BIB_MMS))
    )

  constructor(
    private log: LogService,
    private restService: CloudAppRestService,
    private eventsService: CloudAppEventsService,
    private alert: AlertService,
    private status: StatusMessageService,
    private loader: LoadingIndicatorService,
    private templateSetRegistry: TemplateSetRegistry,
    private xpath: XPathHelperService
  ) { }

  ngOnInit(): void {
    this.loader.show()
    this.status.set("loading")
    this.hasChanges = false

    this.entities$
      .subscribe(
        (entites) => {
          this.entities = entites
        },
        (error) => {
          this.log.error('ngOnInit failed:', error)
          this.loader.hide()
        })
  }

  ngOnDestroy(): void {
  }

  selectRecord(entity: Entity): void {
    this.hasChanges = false
    this.log.info(entity)
    this.loader.show()
    this.getBibRecord(entity)
      .subscribe(
        (bibRecord) => {
          this.log.info('selectRecord successful:', bibRecord)
          this.selectedEntity = bibRecord
          this.log.info('selected', this.selectedEntity)
          this.xmlRecord = new DOMParser().parseFromString(this.selectedEntity.anies[0], "application/xml")
          this.loader.hide()
        },
        (error) => {
          this.log.error('selectRecord failed:', error)
          this.loader.hide()
        }
      )
  }

  getFormattedXml(): string {
    return xmlFormat(new XMLSerializer().serializeToString(this.xmlRecord), {
      collapseContent: true,
    })
  }

  reset(): void {
    this.selectedEntity = null
    this.hasChanges = false
  }

  getTemplateSets(): TemplateSet[] {
    return this.templateSetRegistry.get()
  }

  applyTemplate(template: Template): void {
    this.loader.show()
    this.status.set('applying template')
    this.log.info('apply template:', template.getName())
    template.applyTemplate(this.xmlRecord)
    this.hasChanges = true
    this.loader.hide()
  }

  save(): void {
    this.loader.show()
    this.status.set('saving record')
    const nzMmsId: Observable<string> = this.getNzMmsIdFromEntity(this.selectedEntity.entity)//this.selectedEntity.mms_id
    const params: { [param: string]: any } = {
      'validate': true,
      'override_warning': true,
      'override_lock': true,
      'cataloger_level': '00'
    }
    const xmlBody: string = this.wrapWithBib(this.xmlRecord)
    const record: Node = this.xpath.querySingle('//record', this.xmlRecord)
    const recordXml: string = new XMLSerializer().serializeToString(record)

    this.log.info('selected entity', this.selectedEntity)

    nzMmsId.subscribe(id => {
      this.restService.call({
        method: HttpMethod.PUT,
        url: `/bibs/${id}`,
        //queryParams: params,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/xml'
        },
        requestBody: `<bib>${recordXml}</bib>`
      }).subscribe(
        (response) => {
          this.log.info('save successful:', response)
          this.eventsService.refreshPage()
          this.loader.hide()
        },
        (error) => {
          this.log.info('save failed:', error)
          this.eventsService.refreshPage()
          this.loader.hide()
        }
      )
    })
  }

  private wrapWithBib(xmlRecord: Document): string {
    const bib: Element = xmlRecord.createElement('bib')
    const record: Node = this.xpath.querySingle('./record', xmlRecord)
    bib.appendChild(record)
    xmlRecord.appendChild(bib)
    return xmlFormat(new XMLSerializer().serializeToString(xmlRecord), {
      collapseContent: true,
    })
  }

  private getBibRecord(entity: Entity): Observable<BibRecord> {
    return this.getNzMmsIdFromEntity(entity)
      .pipe(
        switchMap((id) => {
          return this.restService.call({
            method: HttpMethod.GET,
            url: `/bibs/?nz_mms_id=${id}`
          })
        }),
        switchMap((response) => {
          if (response.bib) {
            const bibRecord: BibRecord = response.bib[0]
            bibRecord.entity = entity
            return of(bibRecord)
          } else {
            const bibRecord: BibRecord = response
            bibRecord.entity = entity
            return of(response)
          }
        })
      )

    //const response = this.restService.call({
    //  method: HttpMethod.GET,
    //  url: entity.link
    //}).pipe(
    //  switchMap((response) => {
    //    if (response.bib) {
    //      const bibRecord: BibRecord = response.bib[0]
    //      bibRecord.entity = entity
    //      return of(bibRecord)
    //    } else {
    //      const bibRecord: BibRecord = response
    //      bibRecord.entity = entity
    //      return of(response)
    //    }
    //  })
    //)
    //return response
  }

  private getNzMmsIdFromEntity(entity: Entity): Observable<string> {
    const id = entity.id
    if (entity.link.indexOf("?nz_mms_id") >= 0) {
      return of(id)
    }
    return this.restService.call({
      method: HttpMethod.GET,
      url: entity.link,
      queryParams: { view: 'brief' }
    })
      .pipe(
        switchMap(response => {
          const nzMmsId: string = response?.linked_record_id?.value
          this.log.info('nzMmsId', nzMmsId)
          return of(nzMmsId)
        }),
        catchError(error => {
          this.log.error('Cannot get NZ MMSID from API. Assuming the MMSID is already from NZ.', error)
          return of(entity.id)
        }),
        shareReplay(1)
      )
  }
}
