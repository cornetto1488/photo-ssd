import XCTest

/// Сквозной тест: симулятор с тестовыми фото + настоящий сервер photossd на той же машине.
/// Проверяет: выгрузка всего, отсутствие повторов после перезапуска, просмотр SSD.
final class ZaletE2ETests: XCTestCase {
    private var server: String { ProcessInfo.processInfo.environment["ZALET_SERVER"] ?? "http://127.0.0.1:8099" }
    private var token: String { ProcessInfo.processInfo.environment["ZALET_TOKEN"] ?? "" }
    private var expected: Int { Int(ProcessInfo.processInfo.environment["ZALET_EXPECTED"] ?? "0") ?? 0 }

    override func setUp() {
        continueAfterFailure = false
    }

    private func api(_ path: String) -> [String: Any]? {
        guard let url = URL(string: server + path) else { return nil }
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = 5
        let sem = DispatchSemaphore(value: 0)
        var out: [String: Any]?
        URLSession.shared.dataTask(with: r) { data, _, _ in
            if let data { out = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 6)
        return out
    }

    private func serverFiles() -> Int { api("/api/v1/ping")?["files"] as? Int ?? -1 }
    private func indexCount() -> Int { (api("/api/v1/index")?["items"] as? [Any])?.count ?? -1 }

    private func makeApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-zaletUITest"]
        app.launchEnvironment = ["ZALET_SERVER": server, "ZALET_TOKEN": token]
        return app
    }

    private func allowAlerts() {
        addUIInterruptionMonitor(withDescription: "Разрешения") { alert in
            for title in ["Allow Full Access", "Allow Access to All Photos", "Allow", "OK", "Разрешить доступ ко всем фото", "Разрешить"] {
                let b = alert.buttons[title]
                if b.exists { b.tap(); return true }
            }
            return false
        }
    }

    func testFullSyncNoDuplicates() throws {
        XCTAssertGreaterThan(expected, 0, "не задано ZALET_EXPECTED")
        XCTAssertEqual(serverFiles(), 0, "сервер должен стартовать пустым")
        allowAlerts()

        // 1. Первый запуск: всё должно выгрузиться.
        let app = makeApp()
        app.launch()
        app.tap() // даёт сработать обработчику системных окон
        let deadline = Date().addingTimeInterval(300)
        var files = 0
        while Date() < deadline {
            files = serverFiles()
            if files >= expected { break }
            sleep(3)
        }
        XCTAssertEqual(files, expected, "на сервер дошло \(files) из \(expected)")

        let finished = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "ВСЁ ВЫГРУЖЕНО")).firstMatch
        XCTAssertTrue(finished.waitForExistence(timeout: 60), "приложение не показало «Всё выгружено»")
        let attach = XCTAttachment(screenshot: app.screenshot())
        attach.name = "после выгрузки"
        attach.lifetime = .keepAlways
        add(attach)

        // 2. Перезапуск: повторов быть не должно.
        app.terminate()
        let app2 = makeApp()
        app2.launch()
        sleep(25)
        XCTAssertEqual(serverFiles(), expected, "после перезапуска появились повторы")
        XCTAssertEqual(indexCount(), expected, "журнал сервера разросся — повторная выгрузка")

        // 3. Вкладка SSD показывает выгруженное.
        app2.tabBars.buttons["SSD"].tap()
        let count = app2.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "\(expected) ")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 30), "во вкладке SSD нет «\(expected) файлов»")
        let shot = XCTAttachment(screenshot: app2.screenshot())
        shot.name = "вкладка SSD"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
