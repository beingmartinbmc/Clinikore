"""Treatment (procedure-performed-on-patient) tests.

Notable business rule: if the caller leaves ``price`` out of the payload
the backend fills it in from ``Procedure.default_price``. That's how the
UI keeps data entry cheap — doctor picks a procedure, cost autofills.
"""
from __future__ import annotations


def test_treatment_price_falls_back_to_procedure_default(client, patient, procedures):
    rct = procedures["Root Canal Treatment"]
    r = client.post(
        "/api/treatments",
        json={
            "patient_id": patient["id"],
            "procedure_id": rct["id"],
            "tooth": "36",
            # Deliberately omit price — server must fill from procedure.
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["price"] == rct["default_price"]


def test_treatment_honors_explicit_price(client, patient, procedures):
    """When the doctor overrides the price (discount, special rate), we
    must not silently replace it with the catalog default."""
    r = client.post(
        "/api/treatments",
        json={
            "patient_id": patient["id"],
            "procedure_id": procedures["Consultation"]["id"],
            "price": 250,  # 50% discount vs. 500 default
        },
    )
    assert r.status_code == 201
    assert r.json()["price"] == 250


def test_list_treatments_for_patient(client, patient, procedures):
    client.post("/api/treatments", json={
        "patient_id": patient["id"],
        "procedure_id": procedures["Scaling & Polishing"]["id"],
    })
    client.post("/api/treatments", json={
        "patient_id": patient["id"],
        "procedure_id": procedures["Consultation"]["id"],
    })
    r = client.get(f"/api/patients/{patient['id']}/treatments")
    assert r.status_code == 200
    assert len(r.json()) == 2
    # procedure_name is joined in for display in PatientDetail.
    names = {t["procedure_name"] for t in r.json()}
    assert names == {"Scaling & Polishing", "Consultation"}


def test_cannot_create_treatment_with_bad_procedure(client, patient):
    r = client.post(
        "/api/treatments",
        json={"patient_id": patient["id"], "procedure_id": 9999},
    )
    assert r.status_code == 400


def test_cannot_create_treatment_with_bad_patient(client, procedures):
    r = client.post(
        "/api/treatments",
        json={"patient_id": 9999, "procedure_id": procedures["Consultation"]["id"]},
    )
    assert r.status_code == 400


def test_delete_treatment_soft_deletes_and_returns_undo_token(client, patient, procedures):
    tid = client.post("/api/treatments", json={
        "patient_id": patient["id"],
        "procedure_id": procedures["Consultation"]["id"],
    }).json()["id"]
    r = client.delete(f"/api/treatments/{tid}")
    assert r.status_code == 200
    body = r.json()
    assert body["undo_token"]
    assert body["entity_type"] == "treatment"

    # Row is hidden from the list endpoint.
    r = client.get(f"/api/patients/{patient['id']}/treatments")
    assert all(t["id"] != tid for t in r.json())

    # Undo brings it back.
    assert client.post(f"/api/undo/{body['undo_token']}").status_code == 200
    r = client.get(f"/api/patients/{patient['id']}/treatments")
    assert any(t["id"] == tid for t in r.json())
